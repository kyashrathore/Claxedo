import { describe, expect, it } from "vitest"
import path from "node:path"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

/**
 * What each server deployment entry closes over.
 *
 * This package ships one Node entry — the single-binary
 * (`self-hosted-node`) that runs local workspaces — plus the Better Auth +
 * D1 worker compositions. Entries share `src/`, so the only
 * thing keeping them apart is which modules each entry can REACH — and
 * reachability is not visible in a composition file, which lists what a
 * deployment mounts rather than what its graph drags along.
 *
 * Scope is deliberately narrow, because most of this boundary is already
 * enforced and a second copy of a rule is a second thing to keep in step:
 *

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
// +1 package on hosted-node and self-hosted-node on 2026-08-09:
// `@claxedo/sandbox-contract`, the dependency-neutral driver identity and
// credential schema those compositions already used from sandbox-manager.
// The edge moved so local/server-core no longer reach lifecycle code; workerd's
// entry does not reach the config/credential consumers and therefore did not
// move. No module or provider SDK was added to either closure.
const ENTRIES = [
  // +1 module (139 -> 140) on 2026-08-08: `deployments/route-ownership.ts`,
  // the composition guard the self-hosted app now installs alongside the
  // hosted core. One dependency-free module, no new package.
  // +12 modules (141 -> 153) for the same canonical usage path plus the
  // self-host-only history/provenance adapters, durable outbox, and the
  // ledger adapter. The one package edge is the pinned, read-only
  // `tokentracker-cli` scanner/pricing library. Combined with dev's
  // sandbox-contract split, then runtime authority reaches the canonical
  // `@claxedo/workspace-relay-protocol` lease TTL contract. The private-session
  // reservation route is the reviewed source owner. These exact 150/35 values
  // are measurements, not headroom.
  // +1 module (measured 149 -> 151, ceiling raised by 1 to 151):
  // `session/list.ts`'s new `hostedSessions()` path (`fix(session-list): list
  // a user-hosted workspace's sessions from its host`) reaches `authority/
  // hosted-session-pull.ts` — self-hosted-node also answers `/api/control/
  // sessions` for workspaces this single-binary control plane routes to a
  // remote host, not only ones it runs locally — and the same `authority/
  // relay-token-record.ts` dedup as the two hosted entries above (self-hosted
  // mints relay runtime tokens through the identical owner now). Neither
  // hosted-shared's `hosted-remote-access-service.ts` nor its
  // `hosted-usage-ledger.ts` are reached here: self-hosted-node keeps its own
  // full `RemoteAccessService` (`self-hosted-node/remote-access-service.ts`,
  // which also enrolls this machine) and its own usage ledger.
  // No new package.
  // +4 modules (151 -> 155): the same workspace SessionEnv split into focused
  // factory, protocol, runtime-env, and admission owners. No new package.
  { name: "self-hosted-node", entry: "src/deployments/self-hosted-node/index.ts", modules: 155, packages: 35 },
] as const

/** The remaining cloud compositions. */
const CLOUD_ENTRIES = ENTRIES.filter((item) => item.name !== "self-hosted-node")
const BETTER_AUTH_D1_LOCKED_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts"
const BETTER_AUTH_D1_CANDIDATE_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts"
const BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY =
  "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.cf.ts"
const HOSTED_CORE_WORKER_ROOT = "src/deployments/hosted-workerd/core-worker.cf.ts"

function closure(entry: string, options: { runtimeOnly?: boolean } = {}) {
  return sourceClosure({ entry: path.join(ROOT, entry), root: ROOT, ...options })
}

describe("server deployment entry closures", () => {
  it("keeps the provider-independent hosted core physically free of optional services", () => {
    const result = closure(HOSTED_CORE_WORKER_ROOT, { runtimeOnly: true })
    const files = result.modules.map((module) => module.relative)
    expect(files).toContain(HOSTED_CORE_WORKER_ROOT)
    expect(files).toContain("src/deployments/hosted-shared/hosted-core-app.ts")
    expect(files).toContain("src/deployments/hosted-workerd/live-sync-room.cf.ts")
    expect(result.unresolved).toEqual([])
    expect(result.opaque).toEqual([])

    const forbiddenFiles = files.filter((file) =>
      [
        "src/hosts/wakes/",
        "src/documents/",
        "src/billing/",
        "settlement-dispatcher.cf.ts",
        "wake-lane.cf.ts",
      ].some((prefix) => file.includes(prefix)),
    )
    expect(forbiddenFiles).toEqual([])
    expect(
      result.packages.filter((name) =>
        [
          "@claxedo/documents-service",
          "@claxedo/wakes",
          "@polar-sh/sdk",
        ].includes(name),
      ),
    ).toEqual([])
  })

  it("keeps the Better Auth D1 locked entry resource-closed", () => {
    const result = closure(BETTER_AUTH_D1_LOCKED_ENTRY, { runtimeOnly: true })
    const files = result.modules.map((module) => module.relative)
    expect(files).toContain(BETTER_AUTH_D1_LOCKED_ENTRY)
    expect(files).toContain("src/platform/auth/better-auth-d1-foundation.ts")
    expect(files).toContain("src/deployments/hosted-workerd/better-auth-d1-release-state.cf.ts")
    expect(result.unresolved).toEqual([])
    expect(result.opaque).toEqual([])
    // The release operator, release identity, paired-recovery proof, and their
    // dependency-neutral gate modules are now explicit fail-closed edges.
    // +1 settled-composition-cache.ts (2026-08-31): the per-isolate rule that a
    // Better Auth composition may be reused only after its lazy init settled —
    // the fix for the live wedged-isolate outage; reviewed owner of that rule.
    expect(result.modules.length).toBeLessThanOrEqual(14)
    // +1 dependency-neutral package: the release identity now reads the
    // canonical empty-service manifest ID from @claxedo/service-contract
    // instead of owning a second string. No service implementation enters the
    // locked graph; the forbidden-package assertions below enforce that half.
    expect(result.packages.length).toBeLessThanOrEqual(7)
    expect(result.packages).toContain("@claxedo/service-contract")

    const forbiddenFiles = files.filter((file) =>
      [
        "authority/hosted-services",
        "core-worker.cf",
        "deployments/hosted-shared/hosted-app",
        "documents/",
        "billing/",
        "sandbox",
      ].some((value) => file.toLowerCase().includes(value)),
    )
    expect(forbiddenFiles).toEqual([])
    expect(
      result.packages.filter((name) =>
        [
          "@claxedo/documents-service",
          "@claxedo/wakes",
          "@claxedo/sandbox-manager",
          "@polar-sh/sdk",
        ].includes(name),
      ),
    ).toEqual([])
  })

  it("keeps the phase-gated cutover Worker separate from locked and optional provider implementations", () => {
    const result = closure(BETTER_AUTH_D1_CANDIDATE_ENTRY, { runtimeOnly: true })
    const files = result.modules.map((module) => module.relative)
    expect(files).toContain(BETTER_AUTH_D1_CANDIDATE_ENTRY)
    expect(files).toContain("src/deployments/hosted-workerd/better-auth-d1-operator.cf.ts")
    expect(files).toContain("src/deployments/hosted-workerd/core-worker.cf.ts")
    expect(result.unresolved).toEqual([])
    expect(result.opaque).toEqual([])
    expect(
      files.filter((file) =>
        [
          "better-auth-d1-locked-worker",
          "authority/adapters/worker/hosted-compose",
          "authority/adapters/worker/retained-sandbox-driver",
          "billing/",
          "documents/",
        ].some((value) => file.toLowerCase().includes(value)),
      ),
    ).toEqual([])
    expect(
      result.packages.filter((name) =>
        [
          "@claxedo/documents-service",
          "@claxedo/wakes",
          "@polar-sh/sdk",
        ].includes(name),
      ),
    ).toEqual([])
  })

  it("keeps the plain candidate free of Agent Plugins and the feature candidate closed over exactly it", () => {
    const plain = closure(BETTER_AUTH_D1_CANDIDATE_ENTRY, { runtimeOnly: true })
    const plainFiles = plain.modules.map((module) => module.relative)
    expect(plainFiles.filter((file) => file.includes("src/agent-plugins/") || file.includes("connections/hosted-d1/"))).toEqual([])

    const feature = closure(BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY, { runtimeOnly: true })
    const files = feature.modules.map((module) => module.relative)
    expect(feature.unresolved).toEqual([])
    expect(feature.opaque).toEqual([])
    expect(files).toContain(BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY)
    expect(files).toContain(BETTER_AUTH_D1_CANDIDATE_ENTRY)
    expect(files).toContain("src/agent-plugins/hosted-composition.ts")
    expect(files).toContain("src/agent-plugins/activation/d1-store.ts")
    expect(files).toContain("src/connections/hosted-d1/setup.ts")
    // The feature adds routes, storage adapters, and the hosted Connections
    // family — never the desktop product, a sandbox provider SDK, or billing.
    expect(
      files.filter((file) =>
        [
          "better-auth-d1-locked-worker",
          "packages/claxedo-local-server/src",
          "billing/",
          "documents/",
          "convex",
        ].some((value) => file.toLowerCase().includes(value)),
      ),
    ).toEqual([])
    expect(
      feature.packages.filter((name) =>
        ["@claxedo/local-server", "@claxedo/documents-service", "@claxedo/wakes", "@polar-sh/sdk", "convex"].includes(name),
      ),
    ).toEqual([])
  })

  it("walks a real graph from every entry, so an empty offender list means something", () => {
    // Positive control. Every boundary assertion below is "the offenders list
    // is empty", which is also what a walk that resolved nothing reports.
    for (const { name, entry } of ENTRIES) {
      const result = closure(entry)
      expect(result.modules.length, `${name} reached no modules`).toBeGreaterThan(50)
      expect(
        result.modules.map((module) => module.relative),
        `${name} is missing its own entry`,
      ).toContain(entry)
      // A single unresolved specifier makes every count and every clean
      // offender list a lower bound rather than an answer.
      expect(result.unresolved, `${name} has specifiers the walk could not resolve`).toEqual([])
      // `import(someVariable)` is an edge no walker and no typechecker can
      // follow. One such edge in this repository survived a package move and
      // broke at runtime with a clean import graph the whole time.
      expect(result.opaque, `${name} has an import the walk cannot follow`).toEqual([])
    }
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
