import { describe, expect, it } from "vitest"
import path from "node:path"
import { shortestForbiddenChain, sourceClosure } from "../../platform/governance/source-closure"

const ROOT = path.resolve(import.meta.dirname, "../../..")
const LOCAL_ENTRY = path.join(ROOT, "src/deployments/local/main.ts")

/**
 * What the desktop-local entry closes over TODAY, measured rather than
 * asserted. The split's whole premise is that this number is far larger than
 * the product needs, and every unit of Phase B exists to bring it down.
 *
 * These are ceilings, not targets. A change that raises either one is adding
 * hosted surface to the unsigned desktop and must be justified; a change that
 * lowers them is progress and should lower the ceiling with it.
 */
const CURRENT_MODULE_CEILING = 259
const CURRENT_PACKAGE_CEILING = 42

function localClosure() {
  const closure = sourceClosure({ entry: LOCAL_ENTRY, root: ROOT })
  return {
    ...closure,
    modules: closure.modules.filter((module) => !module.relative.includes(".test.")),
  }
}

describe("desktop-local entry closure", () => {
  it("stays within its measured ceiling", () => {
    const closure = localClosure()
    expect(closure.modules.length).toBeLessThanOrEqual(CURRENT_MODULE_CEILING)
    expect(closure.packages.length).toBeLessThanOrEqual(CURRENT_PACKAGE_CEILING)
  })

  it("resolves every relative specifier, so the measurement is complete", () => {
    // An unresolved specifier is a hole in the walk: the closure would be
    // under-reported and a boundary breach could hide behind it.
    expect(localClosure().unresolved).toEqual([])
  })

  it("records the hosted surface the unsigned desktop still reaches", () => {
    // Named, not tolerated. Each entry here is a Phase B deletion target, and
    // the list is the checklist for Unit 8's closure enforcement.
    const closure = localClosure()
    const reached = (pattern: RegExp) => closure.modules.some((module) => pattern.test(module.relative))

    expect({
      convexAuthority: reached(/^src\/authority\/adapters\/convex\//),
      connections: reached(/^src\/connections\//),
      channels: reached(/^src\/channels\//),
      documents: reached(/^src\/documents\//),
      cloudSandbox: reached(/^src\/sandbox\//),
      workGraphHost: reached(/^src\/hosts\/workgraph\//),
    }).toEqual({
      convexAuthority: true,
      connections: true,
      channels: true,
      documents: true,
      cloudSandbox: true,
      workGraphHost: true,
    })
  })

  it("names the three edges that carry hosted surface into local modules", () => {
    // Measured 2026-08-08. These are the chains to cut, in the order that
    // removes the most: the whole-product SQL schema barrel is reachable from
    // any module that opens the local database, so it dominates.
    const chainTo = (entry: string, pattern: RegExp) =>
      shortestForbiddenChain({
        entry: path.join(ROOT, entry),
        root: ROOT,
        isForbidden: (module) => pattern.test(module.relative),
      })?.map((module) => module.relative)

    // 1. The local database opens the whole product's schema.
    expect(chainTo("src/deployments/local/embedded-workspace-runtime.ts", /^src\/connections\//)).toEqual([
      "src/deployments/local/embedded-workspace-runtime.ts",
      "src/workspace/store/index.ts",
      "src/sandbox/stores/sqlite-supervisor-state.ts",
      "src/sandbox/stores/lease.sql.ts",
      "src/platform/db/db.ts",
      "src/platform/db/schema.ts",
      "src/connections/connection.sql.ts",
    ])

    // 2. Local workspace inventory reaches cloud sandbox leasing.
    expect(chainTo("src/deployments/local/embedded-workspace-runtime.ts", /^src\/sandbox\//)).toEqual([
      "src/deployments/local/embedded-workspace-runtime.ts",
      "src/workspace/store/index.ts",
      "src/sandbox/stores/sqlite-supervisor-state.ts",
    ])

    // 3. Local agent configuration reaches the Convex control plane.
    expect(chainTo("src/deployments/local/embedded-workspace-runtime.ts", /^src\/authority\/adapters\/convex\//)).toEqual([
      "src/deployments/local/embedded-workspace-runtime.ts",
      "src/hosts/workspace-runtime/runtime-config.ts",
      "src/agent-config/index.ts",
      "src/authority/adapters/convex/workspace-authority/index.ts",
    ])
  })
})
