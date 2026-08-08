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
const CURRENT_MODULE_CEILING = 190
const CURRENT_PACKAGE_CEILING = 35

/**
 * The producers a local-only composition mounts: one per `local-server`-owned
 * route family in Unit 1's table, plus the embedded runtime and PTY proxy those
 * families dispatch through. This is the set `@claxedo/local-server` is composed
 * over, so it — not the mixed `deployments/local/server.ts` — is what decides
 * the package's closure.
 */
const LOCAL_PRODUCERS = [
  "src/deployments/local/embedded-workspace-runtime.ts",
  "src/deployments/local/server-workspace-pty-proxy.ts",
  "src/deployments/local/server-usage-limits.ts",
  "src/deployments/local/port.ts",
  "src/workspace/runtime-dispatch/internals.ts",
  "src/workspace/runtime-dispatch/middleware.ts",
  "src/agent-config/routes/index.ts",
  "src/credentials/routes/credential.ts",
  "src/credentials/routes/provider-auth.ts",
  "src/session/routes/meta-routes.ts",
  "src/deployments/shared-routes/bootstrap.ts",
  "src/sandbox/network/network-policy-routes.ts",
  "src/opencode/compat-routes/index.ts",
]

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
    //
    // The package ceiling rose by one when `@claxedo/server-core` was extracted,
    // and that is the shape every extraction has: the walk stops at package
    // boundaries, so N first-party modules leave the module count and one
    // package name enters. Read the two numbers together — a rising package
    // count with a falling module count is a boundary being drawn, not surface
    // being added.
    const closure = localClosure({ runtimeOnly: true })
    expect(closure.modules.length).toBeLessThanOrEqual(CURRENT_MODULE_CEILING)
    expect(closure.packages.length).toBeLessThanOrEqual(CURRENT_PACKAGE_CEILING)
  })

  it("resolves every relative specifier, so the measurement is complete", () => {
    // An unresolved specifier is a hole in the walk: the closure would be
    // under-reported and a boundary breach could hide behind it.
    expect(localClosure().unresolved).toEqual([])
  })

  it("contains no import the walk cannot follow", () => {
    // `import(someVariable)` is invisible to this walk and to the typechecker.
    // One such edge — a shared module reaching back into the local deployment,
    // written with `@vite-ignore` — survived a package move and broke at
    // runtime with a clean import graph the whole time. Every closure number
    // in this file is only trustworthy while this list is empty.
    expect(localClosure().opaque).toEqual([])
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

  it("keeps hosted surface out of the producers a local-only composition would mount", () => {
    // The unit that follows this one builds a local composition over exactly
    // these producers. Their union is what `@claxedo/local-server` closes over,
    // so it is the number that decides whether the package can be created at
    // all — the mixed `deployments/local/server.ts` closure never can be,
    // because it also serves self-hosted.
    //
    // Measured 2026-08-08: 177 -> 106 modules and 43 -> 4 hosted modules
    // reached, and the four are `sandbox/network/*`, which IS the local-owned
    // `network-policy` route family from Unit 1's table.
    const reached = new Set<string>()
    for (const producer of LOCAL_PRODUCERS) {
      for (const module of sourceClosure({
        entry: path.join(ROOT, producer),
        root: ROOT,
        runtimeOnly: true,
      }).modules) {
        if (!module.relative.includes(".test.")) reached.add(module.relative)
      }
    }

    expect(reached.size).toBeLessThanOrEqual(46)
    expect([...reached].filter((module) => /^src\/(connections|channels|documents|authority\/adapters\/convex|sandbox\/stores|sandbox\/routes|hosts\/workgraph)\//.test(module)))
      .toEqual([])
  })

  it("splits the local producer set into what can move and what is genuinely shared", () => {
    // The number that decides Unit 5's package structure. `@claxedo/local-server`
    // may not depend on `@claxedo/server`, so every module it needs has to
    // either move with it or already live below it.
    //
    // Measured 2026-08-08: of the 106 modules a local composition reaches, 44
    // are local-only and 62 are ALSO reachable from the hosted entries. The 62
    // are the shared core — platform logging/paths/http/db, auth primitives,
    // the credential engine, session metadata — and duplicating them would put
    // two implementations of each responsibility in the repository. They have
    // to move down into a package both products depend on BEFORE local-server
    // can be created.
    const HOSTED_ENTRIES = [
      "src/deployments/hosted-node/index.ts",
      "src/deployments/hosted-workerd/worker.ts",
    ]
    const union = (entries: string[]) => {
      const set = new Set<string>()
      for (const entry of entries) {
        for (const module of sourceClosure({
          entry: path.join(ROOT, entry),
          root: ROOT,
          runtimeOnly: true,
        }).modules) {
          if (!module.relative.includes(".test.")) set.add(module.relative)
        }
      }
      return set
    }
    const local = union(LOCAL_PRODUCERS)
    const hosted = union(HOSTED_ENTRIES)
    const localOnly = [...local].filter((module) => !hosted.has(module))
    const shared = [...local].filter((module) => hosted.has(module))

    expect(localOnly.length).toBeGreaterThanOrEqual(30)
    // Zero. Every module a local composition reaches is now either local-only
    // or lives in `@claxedo/server-core`, which is the condition for creating
    // `@claxedo/local-server` at all.
    expect(shared).toEqual([])
    // Every module a local composition reaches is one or the other; a module
    // that fell out of both would be a hole in the walk.
    expect(localOnly.length + shared.length).toBe(local.size)

    // The shared set is a SHARED CORE, not stray hosted surface: nothing in it
    // is a hosted capability implementation.
    expect(shared.filter((module) => /^src\/(connections|channels|documents|authority\/adapters\/convex|sandbox\/stores|sandbox\/routes|hosts\/workgraph)\//.test(module)))
      .toEqual([])

    // And it is IMPORT-CLOSED: nothing in it reaches a module outside it. That
    // is what makes extracting it a move rather than an untangling — the set
    // can leave this package whole, with no dangling edge back into either
    // product. If this ever fails, the escaping module is the one to place
    // before the move, not after.
    expect([...union(shared)].filter((module) => !shared.includes(module))).toEqual([])
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
