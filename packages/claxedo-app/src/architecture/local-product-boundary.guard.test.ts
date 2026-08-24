import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { shortestForbiddenImportChain, type ProductImportRef } from "./import-graph"

const appRoot = path.resolve(import.meta.dir, "../..")

/**
 * Local product boundary — the app half of the U8 package split.
 *
 * `@claxedo/app` is the LOCAL/shared renderer. Its production entry must close
 * over the local shell, workbench, sessions, terminals, providers, and settings
 * and nothing else; hosted identity, WorkGraph, Documents, cloud runtime, and
 * hosted API clients belong to `@claxedo/cloud-app`.
 *
 * Today that separation does not exist yet — the single `app/entry/index.tsx`
 * is simultaneously the local and the hosted entry, and it initializes Clerk on
 * line one. So this file has two jobs, and only the second one changes later:
 *
 *  1. Prove the SCANNER is discriminating. An injected cross-product edge must
 *     be reported with its shortest import chain. A guard that cannot fail on a
 *     planted violation proves nothing about the real graph, so the fixtures
 *     below are the load-bearing part of this suite.
 *  2. Record the CURRENT hosted reach as a characterization baseline. Unit 9
 *     introduces the real local entry and Unit 10 moves the hosted files out;
 *     at that point `PRE_SPLIT_HOSTED_REACH` becomes `null` and this test flips
 *     from "records the mixed entry" to "enforces the clean one".
 *
 * Type-only imports are excluded: the bundler erases them, so a shared type
 * contract is not a runtime boundary breach. The emitted-artifact gate covers
 * what source scanning alone cannot see.
 */

/** Bare packages that only the hosted product may depend on. */
const HOSTED_PACKAGES = ["@clerk/clerk-js", "@claxedo/workgraph", "convex", "convex/browser"]

/** In-package source roots that own hosted implementations, not local ones. */
const HOSTED_SOURCE_ROOTS = [
  "platform/auth/auth-client",
  "platform/auth/auth-session",
  "platform/runtime/cloud/",
  "features/workgraph/",
  "features/documents/",
  "app/routes/login",
  "app/routes/cli-login",
]

export function isHostedCapability(ref: ProductImportRef) {
  if (HOSTED_PACKAGES.some((pkg) => ref.specifier === pkg || ref.specifier.startsWith(`${pkg}/`))) return true
  const module = ref.module
  if (!module) return false
  return HOSTED_SOURCE_ROOTS.some((root) => module === root || module.startsWith(root) || module.startsWith(`${root}/`))
}

/**
 * How the published entry reaches the identity provider, recorded exactly.
 *
 * This began as the pre-split reality: `app/entry/index.tsx` was the published
 * `@claxedo/app` entry AND the hosted bootstrap, calling `initializeClerk()`
 * directly — one hop, no indirection, which is why the fix had to be a package
 * split rather than a lazy import.
 *
 * That hop is gone. Starting the identity provider moved to the hosted entry,
 * and the auth surface moved to `@claxedo/app/auth`. The last recorded reach
 * was `app/routes/login.tsx` through the entry barrel's route re-exports; the
 * eager-bundle trim removed those re-exports (the barrel now exports only what
 * its three consumers import), so the published entry reaches NO hosted
 * capability at all.
 *
 * Kept as a recorded value rather than deleted: with null pinned, ANY new
 * route from the published entry to an identity provider fails here instead
 * of blending into a known one.
 */
const PRE_SPLIT_HOSTED_REACH = null

function fixtureApp(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "claxedo-local-boundary-"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", exports: {} }))
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, "src", rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

describe("local product boundary", () => {
  test("reports the shortest chain to an injected hosted package edge", () => {
    const root = fixtureApp({
      "entry.ts": `import "./shell"\nimport "./settings"\n`,
      "shell.ts": `import "./deep-a"\n`,
      "deep-a.ts": `import "./deep-b"\n`,
      "deep-b.ts": `import { Clerk } from "@clerk/clerk-js"\nexport const c = Clerk\n`,
      // The SHORT path to the same breach. Breadth-first must prefer it, so the
      // reader is pointed at the tightest coupling instead of whichever branch
      // a depth-first walk happened to descend into first.
      "settings.ts": `import { Clerk } from "@clerk/clerk-js"\nexport const s = Clerk\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isHostedCapability }),
      ).toEqual({
        chain: ["entry.ts", "settings.ts"],
        specifier: "@clerk/clerk-js",
        module: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports the chain to an injected hosted source-root edge", () => {
    const root = fixtureApp({
      "entry.ts": `import "./shell"\n`,
      "shell.ts": `import "./features/workgraph/index"\n`,
      "features/workgraph/index.ts": `export const workgraph = true\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isHostedCapability }),
      ).toEqual({
        chain: ["entry.ts", "shell.ts"],
        specifier: "./features/workgraph/index",
        module: "features/workgraph/index.ts",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("passes a closure that only reaches local capabilities", () => {
    const root = fixtureApp({
      "entry.ts": `import "./shell"\n`,
      "shell.ts": `import "./features/terminal/index"\n`,
      "features/terminal/index.ts": `export const terminal = true\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isHostedCapability }),
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not treat a type-only hosted import as a runtime edge", () => {
    const root = fixtureApp({
      "entry.ts": `import type { Session } from "./platform/auth/auth-session"\nexport type S = Session\n`,
      "platform/auth/auth-session.ts": `export type Session = { id: string }\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isHostedCapability }),
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("records the pre-split mixed entry so Unit 9/10 must change it deliberately", () => {
    expect(
      shortestForbiddenImportChain({
        appRoot,
        entry: "app/entry/index.tsx",
        isForbidden: isHostedCapability,
      }),
    ).toEqual(PRE_SPLIT_HOSTED_REACH)
  })
})
