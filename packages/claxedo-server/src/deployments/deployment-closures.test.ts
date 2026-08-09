import { describe, expect, it } from "vitest"
import path from "node:path"
import { shortestForbiddenChain, sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

/**
 * What each server deployment entry closes over.
 *
 * This package ships three production entries, and they are three different
 * products: two cloud compositions (`hosted-node`, `hosted-workerd`) that are
 * signed, multi-tenant and hold no local execution, and one single-binary
 * (`self-hosted-node`) that does run local workspaces. They share `src/`, so
 * the only thing keeping them apart is which modules each entry can REACH —
 * and reachability is not visible in a composition file, which lists what a
 * deployment mounts rather than what its graph drags along.
 *
 * Scope is deliberately narrow, because most of this boundary is already
 * enforced and a second copy of a rule is a second thing to keep in step:
 *
 *   - `hosted-workerd/worker.import-graph.test.ts` already walks `worker.ts`
 *     and `hosted-shared/hosted-app.ts` and forbids the self-hosted
 *     composition (`deployments/self-hosted-node/`), Node-only packages, and
 *     unmarked workerd-only modules. Nothing here restates that.
 *   - `@claxedo/local-server`'s own `self-hosted-execution.test.ts` already
 *     forbids every production file in this package from reaching a deep
 *     `@claxedo/local-server/...` path — but it constrains WHICH subpath, not
 *     WHICH deployment. Under that rule a cloud entry could import the desktop
 *     product's execution surface through the blessed subpath and pass.
 *   - `local-product-contract.test.ts` / `hosted-product-contract.test.ts`
 *     pin the mounted ROUTE inventories, which is a different question from
 *     the import graph: a module can be reached without mounting a route.
 *
 * So what is left, and what this file adds, is: the Node cloud entry had no
 * import-graph gate at all, and no entry was ever checked for reaching the
 * desktop package.
 */

const ROOT = path.resolve(import.meta.dirname, "../..")

/**
 * Baselines measured 2026-08-08 from the entries themselves, with
 * `runtimeOnly: true` — the edges that survive compilation, i.e. what the
 * deployment can actually execute. The ceilings are the measured values with
 * no headroom on purpose: a ceiling that leaves slack lets a closure grow by a
 * fifth without anyone reading it, and the point of a recorded number is that
 * it gets read when it changes. Growth is a deliberate one-line bump; a fall
 * should lower the number with it.
 */
// +1 module on EVERY entry on 2026-08-09:
// `authority/adapters/convex/workspace-authority/host-enrollment.ts`, the
// Convex half of machine enrollment. It moves all three because every entry
// composes `createConvexAuthority`, and it is one module rather than three:
// the five methods live in one file, importing only what the adapter's other
// modules already do (`./api`, `./executor`, the auth types). No new package.
// +1 package on hosted-node and self-hosted-node on 2026-08-09:
// `@claxedo/sandbox-contract`, the dependency-neutral driver identity and
// credential schema those compositions already used from sandbox-manager.
// The edge moved so local/server-core no longer reach lifecycle code; workerd's
// entry does not reach the config/credential consumers and therefore did not
// move. No module or provider SDK was added to either closure.
const ENTRIES = [
  // +8 modules (132 -> 140) for the unified usage ledger: the route,
  // projection/pricing path, revision contract, turn meter, SQLite ledger and
  // its schema, plus the existing local-host identity owner used to stamp
  // durable facts. The only package edges are Node `fs` for that durable local
  // ledger and the pinned, read-only `tokentracker-cli` pricing catalog.
  // Combined with dev's sandbox-contract split, the exact package count is 28.
  { name: "hosted-node", entry: "src/deployments/hosted-node/index.ts", modules: 140, packages: 28 },
  // The usage authority and dev's host-enrollment extraction add one runtime
  // module each relative to their common base; neither adds a Worker package.
  { name: "hosted-workerd", entry: "src/deployments/hosted-workerd/worker.ts", modules: 109, packages: 13 },
  // +1 module (139 -> 140) on 2026-08-08: `deployments/route-ownership.ts`,
  // the composition guard the self-hosted app now installs alongside the
  // hosted core. One dependency-free module, no new package.
  // +12 modules (141 -> 153) for the same canonical usage path plus the
  // self-host-only history/provenance adapters, durable outbox, and Convex
  // ledger adapter. The one package edge is the pinned, read-only
  // `tokentracker-cli` scanner/pricing library. Combined with dev's
  // sandbox-contract split, the exact package count is 34. These are exact,
  // not headroom.
  { name: "self-hosted-node", entry: "src/deployments/self-hosted-node/index.ts", modules: 153, packages: 34 },
] as const

/** The two cloud compositions. Neither runs a workspace on its own box. */
const CLOUD_ENTRIES = ENTRIES.filter((item) => item.name !== "self-hosted-node")

function closure(entry: string, options: { runtimeOnly?: boolean } = {}) {
  return sourceClosure({ entry: path.join(ROOT, entry), root: ROOT, ...options })
}

function chainTo(entry: string, isForbidden: (relative: string) => boolean) {
  const found = shortestForbiddenChain({
    entry: path.join(ROOT, entry),
    root: ROOT,
    isForbidden: (module) => isForbidden(module.relative),
  })
  return found?.map((module) => module.relative).join("\n  -> ") ?? null
}

describe("server deployment entry closures", () => {
  it("walks a real graph from every entry, so an empty offender list means something", () => {
    // Positive control. Every boundary assertion below is "the offenders list
    // is empty", which is also what a walk that resolved nothing reports.
    for (const { name, entry } of ENTRIES) {
      const result = closure(entry)
      expect(result.modules.length, `${name} reached no modules`).toBeGreaterThan(50)
      expect(result.modules.map((module) => module.relative), `${name} is missing its own entry`).toContain(entry)
      // A single unresolved specifier makes every count and every clean
      // offender list a lower bound rather than an answer.
      expect(result.unresolved, `${name} has specifiers the walk could not resolve`).toEqual([])
      // `import(someVariable)` is an edge no walker and no typechecker can
      // follow. One such edge in this repository survived a package move and
      // broke at runtime with a clean import graph the whole time.
      expect(result.opaque, `${name} has an import the walk cannot follow`).toEqual([])
    }
  })

  it("keeps the self-hosted composition out of the Node cloud entry", () => {
    // `worker.import-graph.test.ts` makes this assertion for `worker.ts`.
    // `hosted-node/index.ts` had no import-graph gate of any kind, and it is
    // the entry most able to reach the single binary by accident: both run on
    // Node, so nothing about a `better-sqlite3` or `node:fs` edge would break
    // the build the way it breaks a Worker bundle. The cloud plane pulling in
    // embedded auth, the SQLite authority and local execution would simply
    // work in CI and be wrong in production.
    const chain = chainTo(
      "src/deployments/hosted-node/index.ts",
      (relative) => relative.startsWith("src/deployments/self-hosted-node/"),
    )

    expect(chain, `hosted-node reaches the self-hosted composition:\n  ${chain}`).toBeNull()
  })

  it("keeps the desktop package out of both cloud entries", () => {
    // `@claxedo/local-server` IS the desktop product: PTY proxying, the local
    // credential store, the embedded Workspace Runtime, the OpenCode compat
    // routes. `self-hosted-node` reaches it on purpose and only through the
    // `self-hosted-execution` port, because the single binary genuinely runs
    // local workspaces — that is why this rule is scoped to the cloud entries
    // rather than to every entry.
    //
    // Nothing else catches this. The Worker's forbidden-bare list names
    // `@claxedo/workspace-runtime` and `better-sqlite3` but not
    // `@claxedo/local-server`, and neither walk follows a bare specifier — so
    // a cloud entry importing the desktop package would drag none of the
    // named packages into its own graph and would pass every existing gate.
    const offenders = CLOUD_ENTRIES.flatMap(({ name, entry }) =>
      closure(entry)
        .packages.filter((pkg) => pkg === "@claxedo/local-server")
        .map((pkg) => `${name} -> ${pkg}`),
    )

    expect(offenders).toEqual([])
  })

  for (const { name, entry, modules, packages } of ENTRIES) {
    it(`records what ${name} closes over`, () => {
      // Not a boundary — a measurement. The two rules above name specific
      // modules and one package; this catches the change that stays inside
      // every named rule and still doubles what a deployment carries, which is
      // how a closure actually grows.
      const result = closure(entry, { runtimeOnly: true })

      expect(result.modules.length, `${name} module closure moved`).toBeLessThanOrEqual(modules)
      expect(result.packages.length, `${name} package closure moved`).toBeLessThanOrEqual(packages)
    })
  }
})
