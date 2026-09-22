import { describe, expect, it } from "vitest"
import path from "node:path"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

/**
 * What each server deployment entry closes over.
 *
 * This package ships one Node entry — the single-binary
 * (`self-hosted-node`) that runs local workspaces — plus the Better Auth +
 * D1 worker compositions. Entries share `src/`, so the only
 * thing keeping them apart is which modules each entry can reach — and
 * reachability is not visible in a composition file, which lists what a
 * deployment mounts rather than what its graph drags along.
 *
 * Scope is deliberately narrow, because most of this boundary is already
 * enforced and a second copy of a rule is a second thing to keep in step:
 *

 *   - `@claxedo/local-server`'s own `self-hosted-execution.test.ts` already
 *     forbids every production file in this package from reaching a deep
 *     `@claxedo/local-server/...` path — but it constrains which subpath, not
 *     which deployment. Under that rule a cloud entry could import the desktop
 *     product's execution surface through the blessed subpath and pass.
 *   - `local-product-contract.test.ts` / `hosted-core-app.test.ts`
 *     pin the mounted route inventories, which is a different question from
 *     the import graph: a module can be reached without mounting a route.
 *
 * So what is left, and what this file adds, is: the Node cloud entry had no
 * import-graph gate at all, and no entry was ever checked for reaching the
 * desktop package.
 */

const ROOT = path.resolve(import.meta.dirname, "../..")

/**
 * Baselines are measured directly from the entries themselves, with
 * `runtimeOnly: true` — the edges that survive compilation, i.e. what the
 * deployment can actually execute. The ceilings are the measured values with
 * no headroom on purpose: a ceiling that leaves slack lets a closure grow by a
 * fifth without anyone reading it, and the point of a recorded number is that
 * it gets read when it changes. Growth is a deliberate one-line bump; a fall
 * should lower the number with it.
 */
const ENTRIES = [
  // self-hosted-node's closure reaches `@claxedo/sandbox-contract` (the
  // dependency-neutral driver identity and credential schema shared with
  // sandbox-manager), `deployments/route-ownership.ts` (the composition guard
  // installed alongside the hosted core), the self-host-only
  // history/provenance adapters, durable outbox, and ledger adapter, the
  // pinned read-only `tokentracker-cli` scanner/pricing library, and the
  // canonical `@claxedo/workspace-relay-protocol` lease TTL contract reached
  // through runtime authority.
  //
  // It also reaches `session/list.ts`'s `hostedSessions()` path into
  // `authority/hosted-session-pull.ts`: this single-binary control plane
  // answers `/api/control/sessions` for workspaces it routes to a remote
  // host, not only ones it runs locally, and shares the `authority/
  // relay-token-record.ts` dedup with the hosted entries (self-hosted mints
  // relay runtime tokens through the same owner). It keeps its own full
  // `RemoteAccessService` (`self-hosted-node/remote-access-service.ts`, which
  // also enrolls this machine) and its own usage ledger; that service composes
  // hosted-shared's `hosted-remote-access-service.ts` for the owner's revoke,
  // so a `claxedo connect` machine is revoked the same way on both planes.
  //
  // The workspace `SessionEnv` is split into focused factory, protocol,
  // runtime-env, and admission modules. `@claxedo/opencode-server-adapter` is
  // registered for operator-configured external OpenCode connections (no
  // engine bundled), and the local signed-web composition's Better Auth
  // native-client is reached as well.
  //
  // `@claxedo/helpers` is the canonical owner of the record-narrowing guards
  // that `workspace/signed-access.ts`, `workspace/routes/index.ts`,
  // `workspace/runtime-token-guards.ts`, `workspace/local-host.ts`, and
  // `hosts/workspace-runtime/workspace-session-admission.ts` each used to
  // define privately. Its `/guards` subpath has zero imports and no host APIs,
  // so it adds one package name and no transitive edges.
  //
  // `@claxedo/mcp` is the first-party MCP endpoint (`/api/claxedo/mcp`); the
  // node mounts it through `src/mcp/first-party-mcp.ts`, the one module the
  // hosted worker shares with it. The package reaches only the MCP SDK, hono,
  // zod, helpers and the runtime contract.
  // +2 modules: `src/mcp/oauth-protected-resource.ts` answers the RFC 9728
  // document that endpoint's own 401 names, and
  // `src/platform/auth/mcp-oauth-scopes.ts` holds the scope and resource names
  // it shares with the OAuth provider. The scope module stays dependency-free
  // on purpose — it is in every auth composition's closure, the Worker's
  // included.
  // +1 module: `src/mcp/oauth-credential.ts`, which turns a consented access
  // token into an MCP credential. Consent revocation adds platform/auth/oauth-consent-revocation.ts; 139/38.
  // +1 package: `@claxedo/tasks`, reached only through
  // `src/tasks/self-hosted-composition.ts` — the SIGNED posture's Tasks
  // composition, which `self-hosted-node/start.ts` selects from the composed
  // `services.auth.config.enabled`.
  // +1 package: `@claxedo/egress-broker`, whose mount policy — the
  // `/bindings/*` pattern, the loopback gate and the CORS carve-out — this
  // binary shares with the desktop composition rather than hand-typing. It
  // holds the credential values and may bind 0.0.0.0, so it is a broker host;
  // the package reaches only jose, @hono/node-server and the runtime contract.
  // The host-connect control plane this node serves for a `claxedo connect`
  // fleet is four modules of the closure: `routes/hosted/host-enrollment.ts`
  // owns invitations, machine beats, acquire and scope;
  // `workspace/host-assignment-handlers.ts` owns the owner assigning a directory
  // on an enrolled machine, which the self-host workspace routes dispatch to
  // on a `hostId` body; hosted-shared's `hosted-remote-access-service.ts`
  // owns revoke; `platform/http/status.ts` is how the two routes answer an
  // authority refusal with its own status.
  //
  // The 41st package is `@claxedo/agent-runtime-contract`, reached from
  // `src/channels/control-plane.ts` so a channel Stop decodes the outcome its
  // workspace runtime answers with instead of reading fields off the JSON.
  // +2 modules: `session/deferred-turn-grant.ts`, the signed proof a
  // background turn redeems in place of the credential it no longer holds,
  // which the embedded runtime policy mints and redeems in process over the
  // same key the HTTP oracle uses; and `platform/auth/runtime-token-keys.ts`,
  // the key-pair loader it shares with the owner grant, unreached here before
  // because this node composes no owner grants. No package edge.
  // `script/product-boundary/policies/server.ts` holds the review; this is the
  // same measurement recorded a second time, so the two must agree. 127/41.
  { name: "self-hosted-node", entry: "src/deployments/self-hosted-node/index.ts", modules: 127, packages: 41 },
] as const

/** The remaining cloud compositions. */
const CLOUD_ENTRIES = ENTRIES.filter((item) => item.name !== "self-hosted-node")
const BETTER_AUTH_D1_LOCKED_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts"
const BETTER_AUTH_D1_CANDIDATE_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts"
const BETTER_AUTH_D1_AGENT_PLUGINS_FULL_HOSTED_ENTRY =
  "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.full-hosted.cf.ts"
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
    // dependency-neutral gate modules are explicit fail-closed edges, as is
    // `settled-composition-cache.ts`: the per-isolate rule that a Better Auth
    // composition may be reused only after its lazy init settles.
    // +1: `platform/auth/mcp-oauth-scopes.ts`, the MCP scope and resource
    // names the OAuth provider registers. A dependency-free leaf over string
    // literals, so it adds no edge of its own.
    // +1: `platform/auth/oauth-consent-revocation.ts`, owned by
    // `better-auth-d1-foundation.ts`'s plugin list, which every Better Auth
    // composition here shares: Better Auth deletes a consent without revoking
    // its opaque access and refresh tokens, and this Worker issues both. A
    // plugin over `better-auth/api`, already in this graph, so no package edge.
    // +1: `platform/auth/device-approval-transaction.ts`, from that same
    // plugin list. Better Auth authorizes `/device/approve` on the short,
    // hand-typed user code plus whoever claimed it, so an approval here also
    // carries an HMAC over the request row the approver was shown. Another
    // plugin over `better-auth/api`, so no package edge.
    expect(result.modules.length).toBeLessThanOrEqual(17)
    // The release identity reads its empty-service manifest ID from the
    // dependency-neutral `@claxedo/service-contract` rather than owning a
    // second string. No service implementation enters the locked graph; the
    // forbidden-package assertions below enforce that half.
    //
    // `@claxedo/helpers` enters through `better-auth-d1-operator.cf.ts`, which
    // narrows an operator request body with the canonical `assertRecord`. The
    // `@claxedo/helpers/guards` subpath has zero imports and no host APIs, so
    // it stays workerd-valid and adds no transitive edge of its own.
    expect(result.packages.length).toBeLessThanOrEqual(8)
    expect(result.packages).toContain("@claxedo/service-contract")

    const forbiddenFiles = files.filter((file) =>
      [
        "authority/hosted-services",
        "core-worker.cf",
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

  it("keeps sandbox providers out of every control-plane-only candidate and inside the full-hosted one", () => {
    const providerMarkers = ["sandbox-manager/src/drivers/", "src/sandbox/stores/d1.ts", "hosted-sandbox-driver.ts"]
    for (const entry of [BETTER_AUTH_D1_CANDIDATE_ENTRY, BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY]) {
      const files = closure(entry, { runtimeOnly: true }).modules.map((module) => module.relative)
      expect(files.filter((file) => providerMarkers.some((marker) => file.includes(marker)))).toEqual([])
    }
    const fullHosted = closure(BETTER_AUTH_D1_AGENT_PLUGINS_FULL_HOSTED_ENTRY, { runtimeOnly: true })
    const files = fullHosted.modules.map((module) => module.relative)
    expect(fullHosted.unresolved).toEqual([])
    expect(fullHosted.opaque).toEqual([])
    expect(files).toContain(BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY)
    expect(files).toContain("src/authority/adapters/worker/hosted-sandbox-driver.ts")
    expect(files).toContain("src/sandbox/stores/d1.ts")
    // The provider SDKs are package edges of the driver composer, not source
    // files of this package; the composer itself is the edge that matters.
    expect(fullHosted.packages).toContain("@claxedo/sandbox-manager")
    // Still no desktop product, billing, or the retired stack.
    expect(
      files.filter((file) =>
        ["better-auth-d1-locked-worker", "packages/claxedo-local-server/src", "billing/", "convex"].some((value) =>
          file.toLowerCase().includes(value),
        ),
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
    // `@claxedo/local-server` is the desktop product: PTY proxying, the local
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
