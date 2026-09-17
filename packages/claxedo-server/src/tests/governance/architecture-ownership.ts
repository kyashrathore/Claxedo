export const OwnershipStatus = {
  Canonical: "canonical",
  Compatibility: "compatibility",
  /**
   * A module that was removed and must not come back. The entry pins the
   * deletion — `tests/governance/codebase-shape.test.ts` asserts the path does NOT exist and that
   * a `canonicalReplacement` names what supersedes it, so a revert or a
   * same-named reintroduction fails rather than silently restoring the module.
   */
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
    module: "../../claxedo-server-core/src/platform/auth/authority.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane authority port",
    tests: [
      "authority/services.test.ts",
    ],
  },
  {
    area: "authority",
    module: "authority/adapters/worker/hosted-compose.ts",
    status: OwnershipStatus.Deleted,
    owner: "Worker hosted authority/lease composition adapter (removed; Better Auth + D1 composes via better-auth-d1-compose)",
    canonicalReplacement: "authority/adapters/worker/better-auth-d1-compose.ts",
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
    module: "sandbox/stores/sqlite.ts",
    status: OwnershipStatus.Canonical,
    owner: "SandboxLeaseStore local durable driver",
    tests: ["workspace/supervisor/cloud.test.ts"],
  },
  {
    area: "lease",
    module: "sandbox/stores/sqlite-supervisor-state.ts",
    status: OwnershipStatus.Compatibility,
    owner: "local supervisor SQLite row-state adapter",
    canonicalReplacement: "../../sandbox-manager/src/index.ts plus sandbox-manager/stores/sqlite.ts",
    reason: "Keeps local workspace-supervisor row and hold compatibility under the SandboxManager storage boundary instead of a second top-level lease authority.",
    removalCondition: "Delete when the local supervisor consumes only SandboxManager and SandboxLeaseStore operations.",
    tests: ["workspace/supervisor/cloud.test.ts", "workspace/store/index.test.ts"],
  },
  {
    area: "host",
    module: "sandbox/provision-events.ts",
    status: OwnershipStatus.Canonical,
    owner: "sandbox provision event publisher",
    reason: "Production host lifecycle code emits provision events without depending on manual live sandbox probes.",
    tests: ["sandbox/provision-events.test.ts"],
  },
  {
    area: "host",
    module: "workspace/supervisor/sandbox.ts",
    status: OwnershipStatus.Canonical,
    owner: "local supervisor SandboxManager composer",
    reason: "The local Claxedo product path dogfoods SandboxManager and SandboxDriver directly for cloud workspaces.",
    tests: [
      "workspace/supervisor/cloud.test.ts",
      "authority/services.test.ts",
    ],
  },
  {
    area: "lease",
    module: "authority/http/index.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane runtime register and heartbeat routes",
    canonicalReplacement: "../../sandbox-manager/src/index.ts plus SandboxLeaseStore heartbeat/touch methods",
    reason: "Runtime register and heartbeat routes update the canonical SandboxManager lease; legacy cloud authority rows are no longer written.",
    tests: ["authority/http/index.test.ts"],
  },
  {
    area: "mirror",
    module: "adapters/central-store/mirror.ts",
    status: OwnershipStatus.Canonical,
    owner: "MirrorController",
    reason: "createMirrorController owns each mirror adapter, subscription, pending lease set, and flush timer.",
    tests: ["tests/integration/host-primitives.test.ts"],
  },
  {
    area: "projection",
    // Moved to @claxedo/server-core in the local/cloud package split: BOTH
    // products persist streamed message events, so the module could not stay in
    // the hosted package. Recorded as Deleted-here rather than dropped from the
    // table, so a revert that recreates it under src/ is caught.
    module: "session/message-replay.ts",
    status: OwnershipStatus.Deleted,
    owner: "local session message replay projection",
    canonicalReplacement: "../../claxedo-server-core/src/session/message-replay.ts",
    reason: "Persists streamed workspace-runtime message events into the projection store, for the desktop-local and hosted products alike.",
    tests: ["../../claxedo-server-core/src/session/message-replay.test.ts"],
  },
  {
    area: "projection",
    // Moved to @claxedo/server-core with message-replay above, and for the same
    // reason: both products mirror session summaries into claxedo.db.
    module: "session/sync.ts",
    status: OwnershipStatus.Deleted,
    canonicalReplacement: "../../claxedo-server-core/src/session/sync.ts",
    owner: "local cloud session projection sync",
    reason: "Mirrors cloud workspace session summaries and messages into claxedo.db for local reads; it is not sandbox driver or lease code.",
    tests: ["../../claxedo-server-core/src/session/sync.test.ts"],
  },
  {
    area: "registry",
    module: "../../claxedo-server-core/src/credentials/registry.ts",
    status: OwnershipStatus.Canonical,
    owner: "local credential registry",
    tests: [
      "../../claxedo-server-core/src/credentials/registry.test.ts",
      "../../claxedo-server-core/src/credentials/operations/sync.test.ts",
    ],
  },
  {
    area: "registry",
    module: "credentials/worker/index.ts",
    status: OwnershipStatus.Canonical,
    owner: "hosted credential registry adapter",
    tests: ["credentials/worker/index.test.ts"],
  },
  {
    area: "registry",
    module: "../../claxedo-server-core/src/agent-plugins/catalog/index-collection.ts",
    status: OwnershipStatus.Canonical,
    owner: "Agent Plugins catalog indexer",
    tests: ["../../claxedo-server-core/src/agent-plugins/catalog/index-collection.test.ts"],
  },
  {
    area: "host",
    module: "../../claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts",
    status: OwnershipStatus.Canonical,
    owner: "embedded local Sandbox composer",
    reason: "Local workspaces are served by an in-process Workspace Runtime app; this module composes that host and applies pre-resolved runtime snapshots without implementing harness adapters itself.",
    tests: [
      "tests/governance/codebase-shape.test.ts",
      "workspace/runtime-dispatch/runtime-wait.test.ts",
      "../../claxedo-local-server/src/agent-config/routes/connection-routes.test.ts",
    ],
  },
  {
    area: "host",
    module: "../../claxedo-server-core/src/workspace/http/sandbox-target-fetch.ts",
    status: OwnershipStatus.Canonical,
    owner: "Sandbox request bridge",
    reason: "Server routes use this bridge to fetch local embedded or cloud Workspace Runtime hosts without owning runner execution.",
    tests: [
      "documents/routes/index.test.ts",
      "tests/governance/codebase-shape.test.ts",
    ],
  },
  {
    area: "host",
    module: "../../claxedo-local-server/src/agent-config/fanout.ts",
    status: OwnershipStatus.Canonical,
    owner: "Sandbox runtime config fan-out",
    reason: "Agent config changes broadcast already-resolved runtime snapshots to active sandboxs.",
    tests: [
      "../../claxedo-server-core/src/agent-config/index.test.ts",
      "tests/governance/codebase-shape.test.ts",
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
      "../../workspace-runtime/src/workspace/runtime-connection-provider.test.ts",
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
    module: "../../claxedo-local-server/src/workspace/runtime-dispatch/internals.ts",
    status: OwnershipStatus.Canonical,
    owner: "Workspace Runtime proxy dispatcher",
    reason: "The local server dispatches runtime-owned routes to embedded or cloud Workspace Runtime hosts through this module.",
    tests: [
      "workspace/runtime-dispatch/route-ownership-contract.test.ts",
      "workspace/runtime-dispatch/runtime-wait.test.ts",
      "tests/governance/codebase-shape.test.ts",
    ],
    routeSamples: [
      "/session/s1",
    ],
  },
  {
    area: "route",
    module: "../../claxedo-server-core/src/platform/governance/route-ownership.ts",
    status: OwnershipStatus.Canonical,
    owner: "central route ownership classifier",
    tests: ["workspace/runtime-dispatch/route-ownership-contract.test.ts"],
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
    module: "routes/runtime-session-authority.ts",
    status: OwnershipStatus.Canonical,
    owner: "runtime session authority oracle",
    reason:
      "Isolated workspace runtimes cannot read session participation themselves. They present their already-verified Relay Host Token as an opaque proof; this route re-verifies the relay signature and expiry, then derives actor and workspace ONLY from signed claims — a request body can never assert an actor. Mounted at /api/runtime-authority by self-hosted-node/app.ts and hosted-core-app.ts alike.",
    tests: [
      "routes/runtime-session-authority.test.ts",
      "authority/two-user-runtime-transport.acceptance.test.ts",
      "tests/governance/codebase-shape.test.ts",
    ],
    routeSamples: ["/api/runtime-authority/session-authorize"],
  },
  {
    area: "route",
    module: "../../claxedo-server-core/src/platform/auth/runtime-actor.ts",
    status: OwnershipStatus.Canonical,
    owner: "signed runtime actor resolver",
    reason:
      "Single place that turns verified control-plane auth into the actor identity forwarded to a runtime, so the proxy, hosted broker, local relay, and connection routes cannot each invent their own actor derivation.",
    tests: [
      "authority/runtime-actor.test.ts",
      "authority/two-user-runtime-transport.acceptance.test.ts",
    ],
  },
  {
    area: "route",
    module: "../../claxedo-server-core/src/platform/http/local-only-projection.ts",
    status: OwnershipStatus.Canonical,
    owner: "local-only route guard",
    tests: ["../../claxedo-server-core/src/platform/http/local-only-projection.test.ts"],
  },
  {
    area: "projection",
    module: "authority/projection-store.ts",
    status: OwnershipStatus.Canonical,
    owner: "ControlPlane ProjectionStore",
    tests: [
      "authority/projection-store.test.ts",
      "authority/durable-state.test.ts",
    ],
  },
  {
    area: "projection",
    module: "../../claxedo-server-core/src/platform/auth/durable-session-log.ts",
    status: OwnershipStatus.Canonical,
    owner: "ControlPlane DurableSessionLog",
    tests: [
      "../../claxedo-server-core/src/platform/auth/durable-session-log.test.ts",
      "authority/durable-state.test.ts",
    ],
  },
  {
    area: "projection",
    module: "../../claxedo-server-core/src/platform/http/local-only-projection.ts",
    status: OwnershipStatus.Compatibility,
    owner: "local-only projection route compatibility",
    canonicalReplacement: "ControlPlaneAuthAdapter-gated route factories",
    reason: "Local server still exposes loopback-only projections for local surfaces.",
    removalCondition: "Local-only route surfaces are either removed or compose the same route factories with explicit auth policies.",
    tests: ["../../claxedo-server-core/src/platform/http/local-only-projection.test.ts"],
  },
  // Worker-safe route modules: shared control plane.
  {
    area: "route",
    module: "session/routes/control-plane-session.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane session routes",
    reason:
      "No workspace store, SQLite, or fs in its import graph, so it is Worker-safe shared control plane.",
    tests: ["session/routes/control-plane-session.test.ts"],
    routeSamples: ["/api/control/sessions/s1/gateway"],
  },
  {
    area: "route",
    module: "authority/routes/jwks.ts",
    status: OwnershipStatus.Canonical,
    owner: "control-plane JWKS route",
    reason:
      "Depends only on web-crypto, runtime-access-token, jose and hono, so it is Worker-safe and mounted by both compositions.",
    tests: ["authority/routes/jwks.test.ts"],
    routeSamples: ["/.well-known/jwks.json"],
  },
  // Route modules kept local by a Worker-forbidden import; each reason names it.
  {
    area: "route",
    module: "../../claxedo-local-server/src/session/routes/meta-routes.ts",
    status: OwnershipStatus.Canonical,
    owner: "local session-meta routes (Claxedo local adapter)",
    reason:
      "Imports resolveWorkspace from the workspace store (fs/child_process/SQLite), so it stays local.",
    tests: ["../../claxedo-local-server/src/session/routes/meta-routes.test.ts"],
    routeSamples: ["/api/claxedo/session/s1/meta"],
  },
  {
    area: "route",
    module: "../../claxedo-local-server/src/sandbox/network/network-policy-routes.ts",
    status: OwnershipStatus.Canonical,
    owner: "local network-policy routes (Claxedo local adapter)",
    reason:
      "Imports the network policy store, which reads the SQLite ClaxedoDB, so it stays local.",
    tests: ["../../claxedo-local-server/src/sandbox/network/network-policy-routes.test.ts"],
    routeSamples: ["/api/claxedo/network-policy"],
  },
  {
    area: "route",
    module: "../../claxedo-server-core/src/documents/routes/index.ts",
    status: OwnershipStatus.Canonical,
    owner: "Documents HTTP adapter",
    reason: "Thin Worker-safe route adapter composed with placement-specific index and DocumentWorkspace backends.",
    tests: ["documents/routes/index.test.ts"],
    routeSamples: ["/documents", "/documents/document_1/content"],
  },
  {
    area: "route",
    module: "../../claxedo-local-server/src/deployments/shared-routes/bootstrap.ts",
    status: OwnershipStatus.Canonical,
    owner: "local bootstrap route (Claxedo local adapter)",
    reason:
      "Imports the workspace store and the runtime data paths (fs), so it stays local.",
    tests: ["../../claxedo-local-server/src/deployments/shared-routes/bootstrap.test.ts"],
    routeSamples: ["/api/claxedo/bootstrap"],
  },
  {
    area: "route",
    module: "workspace/routes/index.ts",
    status: OwnershipStatus.Canonical,
    owner: "local workspace routes (Claxedo local adapter)",
    reason:
      "Imports the workspace store and supervisor (fs/child_process/SQLite), so it stays local.",
    tests: ["workspace/routes/index.test.ts"],
    routeSamples: ["/api/workspace"],
  },
  {
    area: "registry",
    module: "../../claxedo-local-server/src/credentials/provider-auth/service.ts",
    status: OwnershipStatus.Canonical,
    owner: "provider auth method service (Claxedo local adapter)",
    reason:
      "A service, not a route, with three local importers; it stays with the local credentials adapter rather than behind a shared barrel.",
    tests: ["../../claxedo-local-server/src/credentials/routes/provider-auth.test.ts"],
  },
  {
    area: "registry",
    module: "../../claxedo-server-core/src/adapters/relay/index.ts",
    status: OwnershipStatus.Canonical,
    owner: "Claxedo relay provider adapter",
    reason:
      "Imports @claxedo/workspace-relay and the region module behind the services.relay port; product-specific, not shared control plane.",
    tests: ["../../claxedo-server-core/src/adapters/relay/index.test.ts"],
  },
  {
    area: "registry",
    module: "../../claxedo-server-core/src/credentials/backends/local.ts",
    status: OwnershipStatus.Canonical,
    owner: "local credential secret backend",
    reason:
      "Reads a local registry file (fs + crypto) behind the services.credentials port, so it stays local.",
    tests: ["../../claxedo-server-core/src/credentials/registry.test.ts"],
  },
] as const satisfies readonly ArchitectureOwnershipEntry[]

export function architectureOwnershipEntries(): readonly ArchitectureOwnershipEntry[] {
  return ARCHITECTURE_OWNERSHIP
}
