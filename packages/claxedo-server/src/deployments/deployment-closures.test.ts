import { describe, expect, it } from "vitest"
import path from "node:path"
import { sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

/**
 * What each Cloudflare Worker entry of this package closes over.
 *
 * The entries share `src/`, so the only thing keeping them apart is which
 * modules each can reach, and reachability is not visible in a composition
 * file: it lists what a deployment mounts rather than what its graph drags
 * along. `hosted-core-app.test.ts` pins the mounted route inventory, which is a
 * different question: a module can be reached without mounting a route.
 */

const ROOT = path.resolve(import.meta.dirname, "../..")

const BETTER_AUTH_D1_ENTRY = "src/deployments/hosted-workerd/better-auth-d1-worker.cf.ts"
const BETTER_AUTH_D1_AGENT_PLUGINS_FULL_HOSTED_ENTRY =
  "src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf.ts"
const BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY =
  "src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.cf.ts"
const HOSTED_CORE_WORKER_ROOT = "src/deployments/hosted-workerd/core-worker.cf.ts"

/**
 * Measured with `runtimeOnly: true`, the edges that survive compilation, and
 * recorded with no headroom: a fall lowers the number with it, and growth is a
 * deliberate bump someone reads.
 */
const ENTRIES = [
  // Every entry carries the D1 access model: the authorization rules, the access
  // context, the org-member, project-member and team authorities, the host
  // access error contract, the D1 session authority's input validation, the
  // verified-email account lookup, the owner of whose connections a turn spends
  // (`connections/turn-owner.ts`), the session authority routes' answer for a
  // decision that threw (`session/runtime-authority-errors.ts`), the one
  // D1 constraint-failure reader and the org/People typed refusal envelope.
  // Every entry also mounts hosted Pages
  // from `core-worker.cf.ts`: the D1 document authority
  // (`authority/adapters/d1/document-authority.ts`), the R2 documents backend
  // and its index and managed store (`documents/backends/hosted/`), and the
  // runtime broker that hydrates a page into a session with its relay client
  // (`documents/relay-http.ts`). The hosted runtime delivery reads a
  // workspace's recorded backing (`workspace/cloud-root-backing.ts`) before it
  // provisions a sandbox, which the Agent Plugins entries already carried.
  // Every entry carries the D1 workspace authority's refusal type and owner
  // identity helpers as modules of their own (`d1/workspace-authority-error.ts`,
  // `d1/owner-identity.ts`), and the machine session-row ingest's reader lookup
  // for status notices (`d1/session-status-notices.ts`), and the live-sync
  // room's nudge admission and replay-gap frame
  // (`hosted-workerd/live-sync-admission.ts`, `live-sync-replay-gap.ts`).
  // Every entry writes a reader's seen and settled marks
  // (`session/routes/session-reader.ts` over `d1/session-reader-store.ts`).
  // The statements that create a workspace (`d1/workspace-creation.ts`) and
  // hosted account setup, which carries the shared credential routes over the
  // per-org stores (`credentials/worker/routes.ts`, `org-routed.ts`), belong
  // to every entry, as does the cloud workspace create's refusal of a branch
  // git would refuse (`workspace/git-branch-name.ts`). Only the Agent Plugins
  // entries mint a repository clone credential (`workspace/repository-clone.ts`).
  // Every entry serves a Pi session on a cloud
  // workspace from its own Durable Object: the session host port
  // (`authority/session-hosts.ts`), its connection mint
  // (`connections/session-host-connection.ts`), its per-turn and delete routes
  // (`routes/session-host-delivery.ts`) and the D1 delete of its row
  // (`d1/hosted-session-delete.ts`), with the session authority's request
  // parsing (`session/runtime-authority-request.ts`) and the D1 session
  // row shapes (`d1/session-rows.ts`) as modules of their own. A reservation
  // places its session by the creator's default harness when it names none
  // (`session/default-session-harness.ts`), and a session host and an
  // enrolled owner's machine are both handed the owner's Pi accounts by one
  // owner (`credentials/direct-rows.ts`). The session authority's signed
  // proofs are minted and read in `session/runtime-session-proofs.ts`.
  // Every entry renews a ChatGPT plan it hands a runtime as its token
  // (`credentials/store-renewal.ts`) and answers a sandbox renewing it
  // mid-turn (`routes/runtime-credential-refresh.ts`) under the turn lease
  // check connection secrets share (`session/turn-lease-authority.ts`), both
  // served by the `routes/runtime-sandbox-secrets.ts` router. Every entry's
  // runtime delivery takes the start phases a cloud runtime it provisioned
  // timed in its sandbox (`workspace/runtime-start-phases.ts`).
  // Every entry composes the sandbox manager over organization keys: the
  // key choice (`sandbox/org-sandbox-drivers.ts`), the per-key lifecycle
  // routing (`sandbox/org-sandbox-manager.ts`), the D1 org's chosen driver
  // (`sandbox/stores/d1-org-driver.ts`) and the credential routes' key policy
  // (`sandbox/hosted-sandbox-driver-keys.ts`); none imports a provider.
  // Every entry deletes an owner's cloud workspace sandbox first
  // (`workspace/cloud-workspace-deletion.ts`), with the D1 deletion statements
  // as a module of their own (`d1/workspace-deletion.ts`). Every entry serves
  // the OpenCode provider catalog from the caller's selected accounts and the
  // workspace engine (`credentials/worker/opencode.ts`). Every entry lists a
  // connected Pi provider's models and answers a Pi draft's options from the
  // launch catalog the session host runs Pi with (`@claxedo/harness/pi-catalog`),
  // which brings `@earendil-works/pi-ai`. Every entry lists a person's machines
  // by enrollment id (`d1/host-devices.ts`) and serializes a
  // workspace row with its repository connection (`d1/workspace-row-json.ts`),
  // each split from its authority. Every entry verifies the per-turn MCP
  // bearer of a session served by its own host (`mcp/session-mcp-credentials.ts`)
  // and mints that session's machine token (`authority/session-host-machine-access.ts`).
  // Every entry admits a verified sign-in to a canonical user and human actor
  // through `d1/application-identity.ts`, split from the workspace authority,
  // and grants, moves and revokes session shares through `d1/session-shares.ts`,
  // split from the session authority.
  { name: "worker", entry: BETTER_AUTH_D1_ENTRY, modules: 155, packages: 20 },
  // Both Agent Plugins entries carry the plugin-backend platform
  // (`src/plugin-backends/`): seven modules, `@claxedo/plugin-api` for the
  // manifest, and `cloudflare:workers` for the supervisor and its entrypoints,
  // plus `agent-plugins/signed-scope.ts`, the caller and write guard the
  // activation and source stores share, and the Pi launch a session served by
  // its own Durable Object is delivered (`agent-plugins/runtime/session-host-launch.ts`).
  // The activation store reads a plugin set's state and builds its writes in
  // two modules beside it (`activation/d1-activation-snapshots.ts`,
  // `activation/d1-activation-writes.ts`), and both D1 stores key rows by the
  // one `agent-plugins/scope-keys.ts`.
  { name: "worker-agent-plugins", entry: BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY, modules: 210, packages: 24 },
  // The full-hosted entry alone carries the session rows pass
  // (`session/session-rows-pass.ts`) and its wiring to the sandbox and the
  // relay (`hosted-workerd/full-hosted-sandbox.ts`): it delivers the pass to a
  // ready cloud runtime and admits it at the session-rows ingest, and only
  // this entry has cloud runtimes to publish rows. It alone hosts the Durable
  // Object a sandbox start runs under (`sandbox/provisioner.cf.ts`) and the
  // start's contract and lookup (`workspace/sandbox-start.ts`), since only it
  // has a sandbox to start.
  { name: "worker-agent-plugins-full-hosted", entry: BETTER_AUTH_D1_AGENT_PLUGINS_FULL_HOSTED_ENTRY, modules: 219, packages: 24 },
] as const

function closure(entry: string, options: { runtimeOnly?: boolean } = {}) {
  return sourceClosure({ entry: path.join(ROOT, entry), root: ROOT, ...options })
}

describe("server deployment entry closures", () => {
  it("mounts the hosted Pages backend in the provider-independent hosted core and never the local one", () => {
    const result = closure(HOSTED_CORE_WORKER_ROOT, { runtimeOnly: true })
    const files = result.modules.map((module) => module.relative)
    expect(files).toContain(HOSTED_CORE_WORKER_ROOT)
    expect(files).toContain("src/deployments/hosted-shared/hosted-core-app.ts")
    expect(files).toContain("src/deployments/hosted-workerd/live-sync-room.cf.ts")
    expect(result.unresolved).toEqual([])
    expect(result.opaque).toEqual([])

    expect(files).toContain("src/documents/backends/hosted/backend.ts")
    expect(files.filter((file) => file.includes("src/documents/backends/local/"))).toEqual([])
  })

  it("keeps the Better Auth D1 Worker free of optional provider implementations", () => {
    const result = closure(BETTER_AUTH_D1_ENTRY, { runtimeOnly: true })
    const files = result.modules.map((module) => module.relative)
    expect(files).toContain(BETTER_AUTH_D1_ENTRY)
    expect(files).toContain("src/deployments/hosted-workerd/core-worker.cf.ts")
    expect(result.unresolved).toEqual([])
    expect(result.opaque).toEqual([])
    expect(files.filter((file) => file.includes("src/documents/backends/local/"))).toEqual([])
  })

  it("keeps the plain Worker free of Agent Plugins and the feature Worker closed over exactly it", () => {
    const plain = closure(BETTER_AUTH_D1_ENTRY, { runtimeOnly: true })
    const plainFiles = plain.modules.map((module) => module.relative)
    expect(plainFiles.filter((file) => file.includes("src/agent-plugins/") || file.includes("connections/hosted-d1/"))).toEqual([])

    const feature = closure(BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY, { runtimeOnly: true })
    const files = feature.modules.map((module) => module.relative)
    expect(feature.unresolved).toEqual([])
    expect(feature.opaque).toEqual([])
    expect(files).toContain(BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY)
    expect(files).toContain(BETTER_AUTH_D1_ENTRY)
    expect(files).toContain("src/agent-plugins/hosted-composition.ts")
    expect(files).toContain("src/agent-plugins/activation/d1-store.ts")
    expect(files).toContain("src/connections/hosted-d1/setup.ts")
    // The feature adds routes, storage adapters, and the hosted Connections
    // family — never the desktop product or a sandbox provider SDK.
    expect(
      files.filter((file) =>
        [
          "packages/claxedo-local-server/src",
          "documents/backends/local/",
          "convex",
        ].some((value) => file.toLowerCase().includes(value)),
      ),
    ).toEqual([])
    expect(
      feature.packages.filter((name) =>
        ["@claxedo/local-server", "convex"].includes(name),
      ),
    ).toEqual([])
  })

  it("keeps sandbox providers out of every control-plane-only Worker and inside the full-hosted one", () => {
    const providerMarkers = ["sandbox-manager/src/drivers/", "src/sandbox/stores/d1.ts", "hosted-sandbox-driver.ts"]
    for (const entry of [BETTER_AUTH_D1_ENTRY, BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY]) {
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
    // Still no desktop product or the retired stack.
    expect(
      files.filter((file) =>
        ["packages/claxedo-local-server/src", "convex"].some((value) =>
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

  it("keeps the desktop package out of every Worker entry", () => {
    // `@claxedo/local-server` is the desktop product: PTY proxying, the local
    // credential store, the embedded Workspace Runtime. The Worker's
    // forbidden-bare list names `@claxedo/workspace-runtime` and
    // `better-sqlite3` but not `@claxedo/local-server`, and neither walk
    // follows a bare specifier, so an entry importing the desktop package would
    // drag none of the named packages into its own graph and pass every other
    // gate.
    const offenders = ENTRIES.flatMap(({ name, entry }) =>
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
