import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { allImportSpecifiers, importSpecifiers, resolveImport, shortestForbiddenImportChain } from "./import-graph"
import { prodSourcePaths } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

/**
 * The cloud workspace runtime, inverted — and kept that way.
 *
 * `platform/runtime/cloud/` is a ONE-module root that fourteen local files
 * imported: bootstrap, the rail, terminals, processes, review, the session
 * composer, actions and harness. `cloud-app-extraction-manifest.test.ts`
 * measured it as the single most expensive edge in the whole extraction,
 * because a module with fourteen local importers cannot be moved at all — there
 * is no "just update the import" for it.
 *
 * It was resolved in two halves, and the split is the thing this file protects:
 *
 *  1. INVERTED. Waking a cloud sandbox, connecting a user-hosted host through
 *     the Relay, and admitting a worktree on that host are hosted operations.
 *     They are declared in `platform/runtime/workspace-startup-port.ts`, named
 *     through `workspaceStartup()`, and bound by the hosted entry.
 *  2. MOVED. Reading the workspace runtime RECORD is not a hosted operation at
 *     all — `http-backend.ts` serves it in every deployment. It was mis-filed
 *     under `cloud/` and now lives in `workspace-runtime-record.ts`, which is
 *     what twelve of the fourteen callers actually wanted.
 *
 * The manifest RECORDS those counts. This file asserts the invariants that keep
 * them true, which a recorded number cannot: that the port seam itself reaches
 * no hosted code (or importing it would re-create the edge one hop out), and
 * that the binding is actually installed (an unbound ports seam is how the
 * WorkGraph doorbell shipped inert with a green suite — see
 * `app-ports-wiring.guard.test.ts`).
 */

const HOSTED_ROOT = "platform/runtime/cloud/"

/**
 * Modules allowed to import the hosted implementation directly, and why.
 *
 * Each is itself hosted and moves to `@claxedo/cloud-app` with it, so the edge
 * leaves rather than breaking. Anything else must go through
 * `workspaceStartup()`.
 */
const ALLOWED_IMPORTERS: Record<string, string> = {
  "app/entry/main.tsx":
    "The hosted composition root. It binds `cloudWorkspaceStartup` into the port; `app/entry/local.tsx` deliberately binds nothing, which is what keeps the hosted implementation out of the local bundle.",
  "features/workspaces/data/workspace-connection.ts":
    "The hosted connection authority. It is on Unit 10's move list and drives the same mint/health/provision sequence, so it binds the implementation directly rather than depending on a port it would take with it.",
}

function modules() {
  return prodSourcePaths(appRoot).map((file) => path.relative(srcRoot, file).split(path.sep).join("/"))
}

/**
 * Every module that imports into `platform/runtime/cloud/`, by importer.
 *
 * Resolved IMPORT SPECIFIERS, never raw file text: a scan for the string
 * "workspace-runtime-store" matches this file's own doc comment, every AGENTS.md
 * sentence about it, and the manifest's prose — and would pass while the real
 * graph rotted. Type-only imports count, because a type import across a package
 * boundary needs an export exactly as loudly as a value one.
 */
function hostedImporters(root: string) {
  const rootSrc = path.join(root, "src")
  const found = new Map<string, string[]>()
  for (const file of prodSourcePaths(root)) {
    const from = path.relative(rootSrc, file).split(path.sep).join("/")
    if (from.startsWith(HOSTED_ROOT)) continue
    const hits = allImportSpecifiers(readFileSync(file, "utf8"))
      .map((specifier) => ({ specifier, resolved: resolveImport(root, file, specifier) }))
      .filter(({ resolved }) => {
        if (!resolved) return false
        return path.relative(rootSrc, resolved).split(path.sep).join("/").startsWith(HOSTED_ROOT)
      })
      .map(({ specifier }) => specifier)
    if (hits.length) found.set(from, hits)
  }
  return found
}

const reachesHosted = (entry: string) =>
  shortestForbiddenImportChain({
    appRoot,
    entry,
    isForbidden: ({ module }) => !!module && module.startsWith(HOSTED_ROOT),
  })

function fixtureApp(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "claxedo-startup-port-"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", exports: {} }))
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, "src", rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

describe("the hosted-importer scanner", () => {
  // Positive controls. Every "the list is exactly the allowlist" assertion below
  // is worthless if this scanner cannot see an edge at all.

  test("reports an injected import of the hosted root, with the specifier that made it", () => {
    const root = fixtureApp({
      "features/terminal/pane.ts": `import { prepare } from "@/platform/runtime/cloud/workspace-runtime-store"\nexport const p = prepare\n`,
      "platform/runtime/cloud/workspace-runtime-store.ts": `export const prepare = 1\n`,
    })
    try {
      expect([...hostedImporters(root)]).toEqual([
        ["features/terminal/pane.ts", ["@/platform/runtime/cloud/workspace-runtime-store"]],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports a TYPE-ONLY import too, and a relative specifier", () => {
    // Both are ways an edge comes back that a value-only, alias-only scan would
    // miss. `local-product-boundary.guard.test.ts` may exclude type imports —
    // it asks about the RUNTIME bundle. This file asks what breaks when the
    // directory is in another package, and a type needs an export either way.
    const root = fixtureApp({
      "features/session/actions.ts": `import type { Result } from "../../platform/runtime/cloud/workspace-runtime-store"\nexport type R = Result\n`,
      "platform/runtime/cloud/workspace-runtime-store.ts": `export type Result = { ok: boolean }\n`,
    })
    try {
      expect([...hostedImporters(root)]).toEqual([
        ["features/session/actions.ts", ["../../platform/runtime/cloud/workspace-runtime-store"]],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not mistake prose about the module for an import of it", () => {
    // The failure mode this scanner exists to avoid: three guards in the
    // session that introduced this port passed by matching their own comments.
    const root = fixtureApp({
      "features/terminal/pane.ts":
        `// See platform/runtime/cloud/workspace-runtime-store.ts for the hosted half.\nconst note = "platform/runtime/cloud/workspace-runtime-store"\nexport const n = note\n`,
      "platform/runtime/cloud/workspace-runtime-store.ts": `export const prepare = 1\n`,
    })
    try {
      expect([...hostedImporters(root)]).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("the cloud workspace runtime stays inverted", () => {
  test("only the hosted composition root and the hosted authority import it", () => {
    const offenders = [...hostedImporters(appRoot)]
      .filter(([from]) => !(from in ALLOWED_IMPORTERS))
      .map(([from, specifiers]) =>
        `${from} imports ${specifiers.join(", ")} -- call workspaceStartup() instead, or the hosted renderer cannot be extracted`,
      )
      .toSorted()

    expect(offenders).toEqual([])

    // Paired positive control: the scan found the real graph, so the emptiness
    // above is a property of the code and not of a resolver that gave up.
    expect([...hostedImporters(appRoot).keys()].toSorted()).toEqual(Object.keys(ALLOWED_IMPORTERS).toSorted())
  })

  test("every allowlisted importer still exists and still imports it, with a reason", () => {
    const live = hostedImporters(appRoot)
    for (const [module, reason] of Object.entries(ALLOWED_IMPORTERS)) {
      expect(live.get(module), `${module} no longer imports the hosted root -- drop it from the allowlist`)
        .toBeDefined()
      expect(reason.length, `${module} needs a reason`).toBeGreaterThan(40)
    }
  })

  test("the port seam local callers import reaches no hosted module", () => {
    // The whole inversion is undone the moment either of these grows a cloud
    // edge: every local caller imports one of them, so the edge would simply
    // reappear one hop further out and the manifest count would stay flat.
    expect(reachesHosted("platform/runtime/workspace-startup.ts")).toBeNull()
    expect(reachesHosted("platform/runtime/workspace-runtime-record.ts")).toBeNull()

    // Positive control for the walk itself: the same walk from a module that
    // DOES reach the hosted root must report it, or the two nulls above prove
    // nothing.
    expect(reachesHosted("app/entry/main.tsx")).not.toBeNull()
  })

  test("the port contract is a contract, not an implementation", () => {
    // Import-free of any implementation, the way `platform/account/account-port.ts`
    // is. `import-graph.ts` exempts it from the orphan guard on exactly this
    // basis — and MEASURED, that exemption does not police the basis: the
    // orphan guard's own `liveTypeContracts` list keeps exempting the file even
    // after it stops being type-only, so a value import there fails nothing
    // over there. This assertion is the only thing holding the property, which
    // is why it names the two allowed type imports rather than just counting.
    const contract = readFileSync(path.join(srcRoot, "platform/runtime/workspace-startup-port.ts"), "utf8")

    expect(importSpecifiers(contract)).toEqual([])
    expect(allImportSpecifiers(contract).toSorted()).toEqual(["./workspace-log", "./workspace-runtime"])
  })
})

describe("the port is bound by composition, and only by the hosted build", () => {
  test("the hosted entry installs the implementation", () => {
    // An unconfigured ports seam does not fail: it degrades. WorkGraph's
    // doorbell shipped that way — a `configure...` nothing called, a whole
    // feature inert, every unit test green.
    const entry = readFileSync(path.join(srcRoot, "app/entry/main.tsx"), "utf8")
    const specifiers = importSpecifiers(entry)

    expect(specifiers).toContain("@/platform/runtime/workspace-startup")
    expect(specifiers).toContain("@/platform/runtime/cloud/workspace-runtime-store")
    expect(entry).toMatch(/configureWorkspaceStartup\(\s*cloudWorkspaceStartup\s*\)/)
  })

  test("the local entry installs nothing, and says so in code rather than in a comment", () => {
    // Scanned over import specifiers, not raw text: this entry's own doc
    // comment names the modules it avoids, and a text scan would fail on the
    // sentence while passing on the import.
    const specifiers = importSpecifiers(readFileSync(path.join(srcRoot, "app/entry/local.tsx"), "utf8"))

    expect(specifiers.filter((specifier) => specifier.includes("runtime/cloud"))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.includes("workspace-startup"))).toEqual([])
  })

  test("no other module claims the binding", () => {
    // A second `configureWorkspaceStartup` call site is a build whose hosted
    // implementation depends on module evaluation order. The declaration in the
    // port module itself is the one legitimate occurrence.
    const callers = modules()
      .filter((module) => module !== "platform/runtime/workspace-startup.ts")
      .filter((module) => /\bconfigureWorkspaceStartup\s*\(/.test(readFileSync(path.join(srcRoot, module), "utf8")))
      .toSorted()

    expect(callers).toEqual(["app/entry/main.tsx"])
  })

  /**
   * What the LOCAL entry still pulls in from the hosted runtime root.
   *
   * Recorded, not asserted away. `local.tsx` no longer reaches the hosted
   * startup through any product surface — the remaining chain runs through the
   * hosted connection authority, `features/workspaces/data/workspace-connection.ts`,
   * which is a different root's direction-1 edge (nine local importers) and a
   * different unit's work.
   *
   * When that authority is inverted in turn, this becomes `toBeNull()` and the
   * local bundle stops containing the Relay startup sequence entirely. Until
   * then the honest statement is "one chain, and here it is", not silence — and
   * a SECOND route appearing fails here rather than blending into a known one.
   */
  test("records the one chain by which the local entry still reaches the hosted runtime", () => {
    const breach = reachesHosted("app/entry/local.tsx")

    expect(breach, "expected the known connection-authority chain; if it is gone, tighten this to toBeNull()")
      .not.toBeNull()
    expect(breach!.module).toBe("platform/runtime/cloud/workspace-runtime-store.ts")
    expect(breach!.chain.at(-1)).toBe("features/workspaces/data/workspace-connection.ts")
  })
})
