export const OwnershipStatus = {
  Canonical: "canonical",
  Compatibility: "compatibility",
  TestOnly: "test-only",
  Deleted: "deleted",
} as const

export type OwnershipStatus = (typeof OwnershipStatus)[keyof typeof OwnershipStatus]

export type ArchitectureOwnershipEntry = {
  area: "authority" | "lease" | "mirror" | "registry" | "host" | "route" | "projection"
  module: string
  status: OwnershipStatus
  owner: string
  canonicalReplacement?: string
  reason?: string
  removalCondition?: string
  tests?: readonly string[]
  routeSamples?: readonly string[]
}

export const ARCHITECTURE_OWNERSHIP = [
  {
    area: "authority",
    module: "control-plane/adapters/convex/convex-authority.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane Convex authority adapter",
    tests: [
      "control-plane/adapters/convex/convex-authority.test.ts",
      "control-plane/services.test.ts",
    ],
  },
  {
    area: "authority",
    module: "control-plane/authority.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane authority port",
    tests: [
      "control-plane/services.test.ts",
    ],
  },
  {
    area: "authority",
    module: "control-plane/adapters/worker/hosted-compose.ts",
    status: OwnershipStatus.Canonical,
    owner: "Worker hosted authority/lease composition adapter",
    tests: [
      "control-plane/hosted-services.test.ts",
    ],
  },
  {
    area: "lease",
    module: "../../sandbox-manager/src/lease-policy.ts",
    status: OwnershipStatus.Canonical,
    owner: "SandboxManager lease policy",
    tests: ["../../sandbox-manager/src/lease-policy.test.ts"],
  },
  {
    area: "lease",
    module: "../../sandbox-manager/src/index.ts",
    status: OwnershipStatus.Canonical,
    owner: "SandboxManager",
    tests: ["../../sandbox-manager/src/manager.test.ts"],
  },
  {
    area: "lease",
    module: "../../sandbox-manager/src/stores/memory.ts",
    status: OwnershipStatus.Canonical,
    owner: "SandboxLeaseStore test/local driver",
    tests: ["../../sandbox-manager/src/manager.test.ts"],
  },
  {
    area: "lease",
    module: "sandbox-manager-adapters/stores/sqlite.ts",
    status: OwnershipStatus.Canonical,
    owner: "SandboxLeaseStore local durable driver",
    tests: ["sandbox-manager-adapters/stores/lease-store-equivalence.test.ts"],
  },
  {
    area: "lease",
    module: "sandbox-manager-adapters/stores/convex.ts",
    status: OwnershipStatus.Canonical,
    owner: "SandboxLeaseStore hosted durable driver",
    tests: [
      "sandbox-manager-adapters/stores/lease-store-equivalence.test.ts",
      "control-plane/convex-sandbox-leases-policy.test.ts",
    ],
  },
  {
    area: "lease",
    module: "sandbox-manager-adapters/stores/sqlite-supervisor-state.ts",
    status: OwnershipStatus.Compatibility,
    owner: "local supervisor SQLite row-state adapter",
    canonicalReplacement: "../../sandbox-manager/src/index.ts plus sandbox-manager/stores/sqlite.ts",
    reason: "Keeps local workspace-supervisor row and hold compatibility under the SandboxManager storage boundary instead of a second top-level lease authority.",
    removalCondition: "Delete when the local supervisor consumes only SandboxManager and SandboxLeaseStore operations.",
    tests: ["workspace/supervisor/cloud.test.ts", "workspace/store/store.test.ts"],
  },
  {
    area: "host",
    module: "sandbox-manager-adapters/provision-events.ts",
    status: OwnershipStatus.Canonical,
    owner: "sandbox provision event publisher",
    reason: "Production host lifecycle code emits provision events without depending on manual live sandbox probes.",
    tests: ["sandbox-manager-adapters/provision-events.test.ts"],
  },
  {
    area: "host",
    module: "workspace/supervisor/sandbox.ts",
    status: OwnershipStatus.Canonical,
    owner: "local supervisor SandboxManager composer",
    reason: "The local Claxedo product path dogfoods SandboxManager and SandboxDriver directly for cloud workspaces.",
    tests: [
      "workspace/supervisor/cloud.test.ts",
      "control-plane/services.test.ts",
    ],
  },
  {
    area: "lease",
    module: "control-plane/http.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane runtime register and heartbeat routes",
    canonicalReplacement: "../../sandbox-manager/src/index.ts plus SandboxLeaseStore heartbeat/touch methods",
    reason: "Runtime register and heartbeat routes update the canonical SandboxManager lease; legacy cloud authority rows are no longer written.",
    tests: ["control-plane/http.test.ts"],
  },
  {
    area: "mirror",
    module: "cloud/mirror.ts",
    status: OwnershipStatus.Canonical,
    owner: "MirrorController",
    reason: "createMirrorController owns each mirror adapter, subscription, pending lease set, and flush timer.",
    tests: ["host-primitives.test.ts"],
  },
  {
    area: "projection",
    module: "cloud/message-replay.ts",
    status: OwnershipStatus.Canonical,
    owner: "local session message replay projection",
    reason: "Persists streamed workspace-runtime message events into the local projection store; it is not sandbox driver or lease code.",
    tests: ["cloud/message-replay.test.ts"],
  },
  {
    area: "projection",
    module: "cloud/session-sync.ts",
    status: OwnershipStatus.Canonical,
    owner: "local cloud session projection sync",
    reason: "Mirrors cloud workspace session summaries and messages into claxedo.db for local reads; it is not sandbox driver or lease code.",
    tests: ["cloud/session-sync.test.ts"],
  },
  {
    area: "registry",
    module: "credentials/registry.ts",
    status: OwnershipStatus.Canonical,
    owner: "local credential registry",
    tests: [
      "credentials/registry.test.ts",
      "credentials/sync.test.ts",
    ],
  },
  {
    area: "registry",
    module: "control-plane/worker-credentials.ts",
    status: OwnershipStatus.Canonical,
    owner: "hosted credential registry adapter",
    tests: ["control-plane/hosted-services.test.ts"],
  },
  {
    area: "registry",
    module: "hosts/agent-extensions/catalog.ts",
    status: OwnershipStatus.Canonical,
    owner: "agent extension catalog",
    tests: ["hosts/agent-extensions/scan.test.ts"],
  },
  {
    area: "host",
    module: "deployments/local/embedded-workspace-runtime.ts",
    status: OwnershipStatus.Canonical,
    owner: "embedded local Sandbox composer",
    reason: "Local workspaces are served by an in-process Workspace Runtime app; this module composes that host and applies pre-resolved runtime snapshots without implementing harness adapters itself.",
    tests: [
      "governance/architecture.test.ts",
      "proxy.timeout.test.ts",
      "control-plane.integration.test.ts",
    ],
  },
  {
    area: "host",
    module: "sandbox-target-fetch.ts",
    status: OwnershipStatus.Canonical,
    owner: "Sandbox request bridge",
    reason: "Server routes use this bridge to fetch local embedded or cloud Workspace Runtime hosts without owning runner execution.",
    tests: [
      "routes/documents.test.ts",
      "governance/architecture.test.ts",
    ],
  },
  {
    area: "host",
    module: "config-fanout.ts",
    status: OwnershipStatus.Canonical,
    owner: "Sandbox runtime config fan-out",
    reason: "Agent config changes broadcast already-resolved runtime snapshots to active sandboxs.",
    tests: [
      "agent-config.test.ts",
      "governance/architecture.test.ts",
    ],
  },
  {
    area: "host",
    module: "../../workspace-runtime/src/workspace/host.ts",
    status: OwnershipStatus.Canonical,
    owner: "Sandbox contract",
    tests: ["../../workspace-runtime/src/workspace/index.test.ts"],
  },
  {
    area: "host",
    module: "../../workspace-runtime/src/workspace/runtime.ts",
    status: OwnershipStatus.Canonical,
    owner: "createSandbox",
    tests: [
      "../../workspace-runtime/src/workspace/runtime.test.ts",
      "../../workspace-runtime/src/workspace/index.test.ts",
    ],
  },
  {
    area: "host",
    module: "../../workspace-runtime/src/workspace/core.ts",
    status: OwnershipStatus.Canonical,
    owner: "sandbox route mount factories",
    tests: ["../../workspace-runtime/src/workspace/index.test.ts"],
  },
  {
    area: "route",
    module: "proxy.ts",
    status: OwnershipStatus.Canonical,
    owner: "Workspace Runtime proxy dispatcher",
    reason: "The local server dispatches runtime-owned routes to embedded or cloud Workspace Runtime hosts through this module.",
    tests: [
      "proxy.test.ts",
      "proxy.timeout.test.ts",
      "governance/architecture.test.ts",
    ],
    routeSamples: [
      "/session/s1",
    ],
  },
  {
    area: "route",
    module: "governance/route-ownership.ts",
    status: OwnershipStatus.Canonical,
    owner: "central route ownership classifier",
    tests: ["proxy.test.ts"],
    routeSamples: [
      "/api/control",
      "/api/workspace",
      "/api/channels/github/webhook",
      "/api/wr/health",
      "/session/s1",
      "/internal/relay/target",
    ],
  },
  {
    area: "route",
    module: "routes/local-only-projection.ts",
    status: OwnershipStatus.Canonical,
    owner: "local-only route guard",
    tests: ["routes/local-only-projection.test.ts"],
    routeSamples: ["/api/workgraph"],
  },
  {
    area: "route",
    module: "routes/opencode-compat.ts",
    status: OwnershipStatus.Compatibility,
    owner: "OpenCode HTTP compatibility routes",
    canonicalReplacement: "Control-plane and workspace-runtime route domains in route-ownership.ts",
    reason: "Existing local OpenCode-compatible clients still call these paths.",
    removalCondition: "All local app and CLI callers use canonical control-plane/workspace-runtime routes.",
    tests: [
      "proxy.test.ts",
      "governance/architecture.test.ts",
    ],
    routeSamples: ["/command", "/mcp", "/agent"],
  },
  {
    area: "projection",
    module: "control-plane/projection-store.ts",
    status: OwnershipStatus.Canonical,
    owner: "ControlPlane ProjectionStore",
    tests: [
      "control-plane/projection-store.test.ts",
      "control-plane/durable-state.test.ts",
    ],
  },
  {
    area: "projection",
    module: "control-plane/durable-session-log.ts",
    status: OwnershipStatus.Canonical,
    owner: "ControlPlane DurableSessionLog",
    tests: [
      "control-plane/durable-session-log.test.ts",
      "control-plane/durable-state.test.ts",
    ],
  },
  {
    area: "projection",
    module: "routes/local-only-projection.ts",
    status: OwnershipStatus.Compatibility,
    owner: "local-only projection route compatibility",
    canonicalReplacement: "ControlPlaneAuthAdapter-gated route factories",
    reason: "Local server still exposes loopback-only projections for WorkGraph and related local surfaces.",
    removalCondition: "Local-only route surfaces are either removed or compose the same route factories with explicit auth policies.",
    tests: ["routes/local-only-projection.test.ts"],
  },
  // --- Unit 5: control-plane-owned route reorganization ---
  // MOVE: generic control-plane route modules whose import graph is
  // services/port-only and Worker-safe. Rehomed under control-plane/routes/.
  {
    area: "route",
    module: "control-plane/routes/control-plane-session.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane session routes",
    reason:
      "Unit 5 MOVE: imports only ControlPlaneServices, the authority port, control-plane/http, control-plane/auth, and type-only session-meta/session-list — no workspace-store, SQLite, or fs. Generic control-plane core, rehomed from routes/.",
    tests: ["control-plane/routes/control-plane-session.test.ts"],
    routeSamples: ["/api/control/sessions/s1/gateway"],
  },
  {
    area: "route",
    module: "control-plane/routes/jwks.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane JWKS route",
    reason:
      "Unit 5 MOVE: serves control-plane signing keys; only dependency is control-plane/web-crypto plus jose/hono. Mounted by both server.ts and hosted-app.ts (already Worker-safe). Rehomed from routes/.",
    tests: ["control-plane/routes/jwks.test.ts"],
    routeSamples: ["/.well-known/jwks.json"],
  },
  // DOCUMENT: generic-in-spirit route modules that stay under routes/ because
  // their import graph is coupled to Worker-forbidden local modules
  // (workspace-store / workspace-supervisor / SQLite storage / process-local
  // bus). Verdicts flipped from the provisional MOVE toward DOCUMENT with
  // import evidence noted per Unit 5's decision rule.
  {
    area: "route",
    module: "routes/session-meta.ts",
    status: OwnershipStatus.Canonical,
    owner: "local session-meta routes (Claxedo local adapter)",
    reason:
      "Unit 5 verdict flipped MOVE→DOCUMENT: imports resolveWorkspace from ../workspace-store (FORBIDDEN_LOCAL, fs/child_process/sqlite). Not Worker-safe, so it stays a local control-plane route adapter under routes/.",
    tests: ["routes/session-meta-routes.test.ts"],
    routeSamples: ["/api/claxedo/session/s1/meta"],
  },
  {
    area: "route",
    module: "routes/network-policy.ts",
    status: OwnershipStatus.Canonical,
    owner: "local network-policy routes (Claxedo local adapter)",
    reason:
      "Unit 5 verdict flipped MOVE→DOCUMENT: transitively imports ../network/policy → ../storage/db (better-sqlite3 + fs). SQLite-coupled, so it stays a local control-plane route adapter under routes/.",
    tests: ["routes/network-policy.test.ts"],
    routeSamples: ["/api/claxedo/network-policy"],
  },
  {
    area: "route",
    module: "routes/documents.ts",
    status: OwnershipStatus.Canonical,
    owner: "Documents HTTP adapter",
    reason: "Thin Worker-safe route adapter composed with placement-specific index and DocumentWorkspace backends.",
    tests: ["routes/documents.test.ts"],
    routeSamples: ["/documents", "/documents/document_1/content"],
  },
  {
    area: "route",
    module: "routes/events.ts",
    status: OwnershipStatus.Canonical,
    owner: "local control-plane events SSE route (Claxedo local adapter)",
    reason:
      "Unit 5 verdict flipped VERIFY→WRAP→DOCUMENT: imports claxedoBus from ../bus → @claxedo/workspace-runtime/host (FORBIDDEN_BARE, process-local). Process-local + Worker-forbidden, so it stays in place with no barrel.",
    tests: ["routes/events.test.ts"],
  },
  {
    area: "route",
    module: "routes/bootstrap.ts",
    status: OwnershipStatus.Canonical,
    owner: "local bootstrap route (Claxedo local adapter)",
    reason:
      "Unit 5 verdict DOCUMENT: imports listProjects from ../workspace-store (FORBIDDEN_LOCAL), ../paths, ../opencode-auth, and node os. env + local provider catalog + opencode-compat coupling, so it stays in place.",
    tests: ["routes/bootstrap.test.ts"],
    routeSamples: ["/api/claxedo/bootstrap"],
  },
  {
    area: "route",
    module: "routes/workspace.ts",
    status: OwnershipStatus.Canonical,
    owner: "local workspace routes (Claxedo local adapter)",
    reason:
      "Unit 5 verdict DOCUMENT: imports ../workspace-store and ../workspace-supervisor (both FORBIDDEN_LOCAL). Local-only workspace-store coupling, so the workspace* route family stays in place under routes/.",
    tests: ["routes/workspace.test.ts"],
    routeSamples: ["/api/workspace"],
  },
  {
    area: "registry",
    module: "provider-auth/service.ts",
    status: OwnershipStatus.Canonical,
    owner: "provider auth method service (Claxedo local adapter)",
    reason:
      "Unit 5 verdict WRAP→DOCUMENT: the implementation is portable (only node:timers + a type import) but it is a service, not a route, so there is no control-plane/routes/ home; with 2 non-test importers (routes/provider-auth.ts, routes/bootstrap.ts) a barrel is not warranted. Left in place and documented.",
    tests: ["routes/provider-auth.test.ts"],
  },
  {
    area: "registry",
    module: "relay-provider/index.ts",
    status: OwnershipStatus.Canonical,
    owner: "Claxedo relay provider adapter",
    reason:
      "Unit 5 verdict DOCUMENT: Claxedo relay adapter consumed via services.relay; imports @claxedo/workspace-relay and ../region. Product-specific relay decision, not generic control-plane core.",
    tests: ["relay-provider/index.test.ts"],
  },
  {
    area: "registry",
    module: "credentials/local.ts",
    status: OwnershipStatus.Canonical,
    owner: "local credential secret backend",
    reason:
      "Unit 5 verdict DOCUMENT: local registry file backend (fs + crypto). The neutral port is services.credentials; this is a Worker-forbidden local adapter that stays in place.",
    tests: ["credentials/registry.test.ts"],
  },
] as const satisfies readonly ArchitectureOwnershipEntry[]

export function architectureOwnershipEntries(): readonly ArchitectureOwnershipEntry[] {
  return ARCHITECTURE_OWNERSHIP
}
