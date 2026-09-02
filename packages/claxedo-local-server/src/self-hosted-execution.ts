/**
 * The local-execution surface a HOST composes.
 *
 * `@claxedo/server` reaches this package for one reason: the self-hosted
 * single-binary runs local workspaces. Rather than let it reach sixteen deep
 * module paths — every one of which is an internal layout this package should be
 * free to change — that dependency goes through here.
 *
 * The contract is deliberately narrow and product-neutral. It provides embedded
 * Workspace Runtime lifecycle, the local route mounters, the compatibility event
 * stream, and the local port constant. It names nothing about Electron, nothing
 * about WorkGraph, and nothing about who is signed in: a host that wants
 * WorkGraph routes inside a local runtime passes them as generic route
 * contributions to `configureEmbeddedWorkspaceRuntime`, which is what keeps
 * WorkGraph's absence from an unsigned desktop a composition fact rather than a
 * runtime flag.
 */

// ── Embedded Workspace Runtime lifecycle ────────────────────────────────────
export {
  configureEmbeddedWorkspaceRuntime,
  embeddedWorkspaceRuntimeSessionAuthority,
  ensureEmbeddedWorkspaceRuntime,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  syncEmbeddedWorkspaceRuntimes,
  syncEmbeddedWorkspaceRuntimeAgentExtensions,
  connectEmbeddedWorkspacePty,
} from "./deployments/local/embedded-workspace-runtime"

// ── Local route surface ─────────────────────────────────────────────────────
export { AgentConfigRoutes } from "./agent-config/routes/index"
export { SessionMetaRoutes } from "./session/routes/meta-routes"
export { LocalWorkspaceRoutes } from "./workspace/routes/resolve-route"
export { OpenCodeCompatRoutes } from "./opencode/compat-routes/index"
export { CredentialRoutes } from "./credentials/routes/credential"
export { ProviderAuthRoutes } from "./credentials/routes/provider-auth"
export { NetworkPolicyRoutes } from "./sandbox/network/network-policy-routes"
export { BootstrapRoutes } from "./deployments/shared-routes/bootstrap"
export { createWorkspaceRuntimeProxy } from "./workspace/runtime-dispatch/middleware"
export { createLocalWorkspaceRelayProxy, localWorkspaceRelayProxy } from "./workspace/runtime-dispatch/shared-workspace-endpoint"
export { mountWorkspaceRuntimePtyWebSocketProxy } from "./deployments/local/server-workspace-pty-proxy"
export { getLocalUsageLimits } from "./deployments/local/server-usage-limits"
export { createSqliteUsageLedger, type SqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
export { createSqliteUsageSourceCoverageStore, type UsageSourceCoverageStore } from "@claxedo/server-core/usage/adapters/sqlite-usage-provenance"
export { scanTokenTrackerLocalHistory, type LocalHistorySnapshot } from "./usage/adapters/token-tracker-local-history"
export { createUsageOutboxSync, type UsageOutboxSync } from "./usage/outbox-sync"
export { LocalUsageRoutes, UsageRoutes, type UsageLedger } from "@claxedo/server-core/usage/routes"

// ── Local execution services ────────────────────────────────────────────────
export { resolveHarnessId } from "./opencode/compat-routes/provider-config"
export { configureOpencodeMcpSync } from "./opencode/mcp-sync"
export {
  createOpencodeEvents,
  type OpencodeEvent,
  type OpencodeEventsHandle,
} from "./opencode/events"
export {
  provisionRegisteredWorktree,
  releaseRegisteredWorktree,
  localWorktreeWorkGraphId,
} from "./workspace/worktree"
export { DEFAULT_CLAXEDO_SERVER_PORT } from "./deployments/local/port"

/**
 * Runtime-dispatch internals the self-hosted relay endpoint composes over.
 *
 * Narrower than it looks: the host builds ONE proxy for a shared workspace and
 * needs the same embedded/cloud resolution the local dispatch path uses. It
 * does not get to reach the rest of the dispatch module.
 */
export {
  embedded,
  ensureCloudRuntime,
  noWr,
  proxy,
  type RuntimeProxyOptions,
} from "./workspace/runtime-dispatch/internals"

/** Records local session metadata from proxied `/session` responses. */
export { sessionMetaProjectionTap } from "./session/session-meta-tap"

/** Migrates legacy plaintext provider credentials into the managed backend. */
export { migrateCredentials } from "./credentials/operations/migrate"
export { projectLocalSessionMetaFromEvent } from "./session/session-meta-tap"

/** Starts the desktop-local server: composition plus lifecycle. */
export { startLocalServer, type LocalServer, type StartLocalServerOptions } from "./app/start-local-server"
export { createLocalApp, mountLocalRouteFamilies, localSecurityHeaders, type LocalAppOptions } from "./app/local-app"
export {
  createLocalDaemonLifecycle,
  localDaemonWorkActivity,
  type LocalDaemonLifecycle,
  type LocalDaemonWorkActivity,
} from "./app/local-daemon-lifecycle"
export { createLocalControlPlaneServices, localSessionProjectionStore } from "./app/local-services"
export { isLocalCredentialPath, localCorsOrigin } from "./app/local-app"
