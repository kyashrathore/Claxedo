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
const CURRENT_MODULE_CEILING = 254
const CURRENT_PACKAGE_CEILING = 41

function localClosure(options: { runtimeOnly?: boolean } = {}) {
  const closure = sourceClosure({ entry: LOCAL_ENTRY, root: ROOT, ...options })
  return {
    ...closure,
    modules: closure.modules.filter((module) => !module.relative.includes(".test.")),
  }
}

describe("desktop-local entry closure", () => {
  it("stays within its measured ceiling", () => {
    // Ratcheted on the EXECUTABLE closure. The declared closure counts type-only
    // edges, which cost a build nothing, so ratcheting it would punish adding a
    // type import and reward nothing for cutting one.
    const closure = localClosure({ runtimeOnly: true })
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

  it("keeps hosted surface out of the embedded runtime's executable closure", () => {
    // Three edges carried hosted surface into local modules, measured
    // 2026-08-08. Each is cut at the module that OWNS the choice rather than
    // at the module that suffered it.
    //
    //   1. `platform/db/db.ts` imported the whole-product schema barrel as a
    //      value, so opening the local database reached connections, channels,
    //      and documents SQL. Drizzle needs it only for `db.query.*`, which
    //      nothing uses, so it is now a type-only edge.
    //   2. `workspace/store/index.ts` imported the supervisor lease table, so
    //      reading local workspace inventory reached cloud sandbox leasing. The
    //      supervisor — which owns leases — now installs the reader.
    //   3. `agent-config/index.ts` selected its own workspace authority, so
    //      reading agent configuration reached the Convex control plane. The
    //      composition now supplies it.
    const chainTo = (pattern: RegExp) =>
      shortestForbiddenChain({
        entry: path.join(ROOT, "src/deployments/local/embedded-workspace-runtime.ts"),
        root: ROOT,
        runtimeOnly: true,
        isForbidden: (module) => pattern.test(module.relative),
      })?.map((module) => module.relative)

    expect({
      connections: chainTo(/^src\/connections\//),
      channels: chainTo(/^src\/channels\//),
      documents: chainTo(/^src\/documents\//),
      cloudSandboxStores: chainTo(/^src\/sandbox\/stores\//),
      convexAuthority: chainTo(/^src\/authority\/adapters\/convex\//),
    }).toEqual({
      connections: undefined,
      channels: undefined,
      documents: undefined,
      cloudSandboxStores: undefined,
      convexAuthority: undefined,
    })
  })

  it("shrinks once type-only edges are discounted", () => {
    // A type-only import is erased whole: no module is loaded and no capability
    // becomes reachable. The gap between these two numbers is the surface a
    // build carries versus the surface the source declares.
    const declared = localClosure()
    const executable = localClosure({ runtimeOnly: true })
    expect(executable.modules.length).toBeLessThan(declared.modules.length)
  })
})
