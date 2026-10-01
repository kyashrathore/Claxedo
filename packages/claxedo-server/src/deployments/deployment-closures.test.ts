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
  // Every entry carries the D1 access model: the project-role query, the access
  // context, the org-member, project-member and team authorities, the host
  // access error contract, the D1 session authority's input validation and
  // access predicates, and the verified-email account lookup. Every entry also
  // mounts hosted Pages from `core-worker.cf.ts`: the D1 document authority
  // (`authority/adapters/d1/document-authority.ts`), the R2 documents backend
  // and its index, managed store and local-relay schemas
  // (`documents/backends/hosted/`), and the runtime broker that hydrates a page
  // into a session with its relay client (`documents/relay-http.ts`).
  { name: "worker", entry: BETTER_AUTH_D1_ENTRY, modules: 115, packages: 19 },
  // Both Agent Plugins entries carry the plugin-backend platform
  // (`src/plugin-backends/`): seven modules, `@claxedo/plugin-api` for the
  // manifest, and `cloudflare:workers` for the supervisor and its entrypoints.
  { name: "worker-agent-plugins", entry: BETTER_AUTH_D1_AGENT_PLUGINS_ENTRY, modules: 166, packages: 23 },
  { name: "worker-agent-plugins-full-hosted", entry: BETTER_AUTH_D1_AGENT_PLUGINS_FULL_HOSTED_ENTRY, modules: 171, packages: 23 },
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
