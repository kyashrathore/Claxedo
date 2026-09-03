import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { shortestForbiddenImportChain, type ProductImportRef } from "./import-graph"

const appRoot = path.resolve(import.meta.dir, "../..")

/**
 * Local product boundary.
 *
 * `@claxedo/app`'s production entry must not close over hosted identity,
 * Documents, cloud runtime, or hosted API clients. Type-only
 * imports are excluded: the bundler erases them. The emitted-artifact gate
 * covers what source scanning cannot see.
 *
 * The published local entry is now separate from the hosted bootstrap. This
 * file has two jobs:
 *
 *  1. Prove the SCANNER is discriminating. An injected cross-product edge must
 *     be reported with its shortest import chain. A guard that cannot fail on a
 *     planted violation proves nothing about the real graph, so the fixtures
 *     below are the load-bearing part of this suite.
 *  2. Enforce that the CURRENT local entry cannot reach a hosted capability.
 *
 * Type-only imports are excluded: the bundler erases them, so a shared type
 * contract is not a runtime boundary breach. The emitted-artifact gate covers
 * what source scanning alone cannot see.
 */

/** Bare packages that only the hosted product may depend on. */
const HOSTED_PACKAGES = [
  "better-auth",
]

/** In-package source roots that own hosted implementations, not local ones. */
const HOSTED_SOURCE_ROOTS = [
  "platform/auth/auth-client",
  "platform/auth/auth-session",
  "platform/runtime/cloud/",
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
      "deep-b.ts": `import { createAuthClient } from "better-auth/client"\nexport const c = createAuthClient\n`,
      // The SHORT path to the same breach. Breadth-first must prefer it, so the
      // reader is pointed at the tightest coupling instead of whichever branch
      // a depth-first walk happened to descend into first.
      "settings.ts": `import { createAuthClient } from "better-auth/client"\nexport const s = createAuthClient\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isHostedCapability }),
      ).toEqual({
        chain: ["entry.ts", "settings.ts"],
        specifier: "better-auth/client",
        module: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports the chain to an injected hosted source-root edge", () => {
    const root = fixtureApp({
      "entry.ts": `import "./shell"\n`,
      "shell.ts": `import "./features/documents/index"\n`,
      "features/documents/index.ts": `export const documents = true\n`,
    })
    try {
      expect(
        shortestForbiddenImportChain({ appRoot: root, entry: "entry.ts", isForbidden: isHostedCapability }),
      ).toEqual({
        chain: ["entry.ts", "shell.ts"],
        specifier: "./features/documents/index",
        module: "features/documents/index.ts",
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

  test("keeps the published local entry free of hosted capabilities", () => {
    expect(
      shortestForbiddenImportChain({
        appRoot,
        entry: "app/entry/index.tsx",
        isForbidden: isHostedCapability,
      }),
    ).toBeNull()
  })
})
