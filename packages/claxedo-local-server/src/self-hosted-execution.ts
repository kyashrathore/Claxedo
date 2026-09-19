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
 * about any hosted capability, and nothing about who is signed in: a host that
 * wants extra routes inside a local runtime passes them as generic route
 * contributions to `configureEmbeddedWorkspaceRuntime`, which is what keeps a
 * hosted capability's absence from an unsigned desktop a composition fact
 * rather than a runtime flag.
 */

export {
  configureEmbeddedWorkspaceRuntime,
  embeddedWorkspaceRuntimeSessionAuthority,
  ensureEmbeddedWorkspaceRuntime,
  onEmbeddedWorkspaceRuntime,
  readEmbeddedWorkspaceSessionConfig,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  syncEmbeddedWorkspaceRuntimes,
  connectEmbeddedWorkspacePty,
  startEmbeddedWorkspaceRuntimeConfigRenewal,
  verifyEmbeddedRuntimeCredential,
} from "./deployments/local/embedded-workspace-runtime"

export { createLocalCredentialBroker } from "./credentials/broker"
export type { LocalCredentialBroker } from "./credentials/broker"

export { AgentConfigRoutes } from "./agent-config/routes/index"
export { SessionMetaRoutes } from "./session/routes/meta-routes"
export { LocalWorkspaceRoutes } from "./workspace/routes/resolve-route"
export { ShellRoutes } from "./shell/routes"
export { createHostAggregateEventsHandler } from "./shell/host-events"
export { LocalProjectRoutes, githubCloneAuthorization } from "./workspace/routes/projects-route"
export { CredentialRoutes, requestOrg } from "./credentials/routes/credential"
export { localControlPlaneCredentials } from "./credentials/machine-credentials"
export { ProviderAuthRoutes } from "./credentials/routes/provider-auth"
export { NetworkPolicyRoutes } from "./sandbox/network/network-policy-routes"
export { BootstrapRoutes } from "./deployments/shared-routes/bootstrap"
export { createWorkspaceRuntimeProxy } from "./workspace/runtime-dispatch/middleware"
export { createLocalWorkspaceRelayProxy, localWorkspaceRelayProxy } from "./workspace/runtime-dispatch/shared-workspace-endpoint"
export { mountWorkspaceRuntimePtyWebSocketProxy } from "./deployments/local/server-workspace-pty-proxy"
export { createSqliteUsageLedger, type SqliteUsageLedger } from "@claxedo/server-core/usage/adapters/sqlite-usage-ledger"
export { createSqliteUsageSourceCoverageStore, type UsageSourceCoverageStore } from "@claxedo/server-core/usage/adapters/sqlite-usage-provenance"
export { scanTokenTrackerLocalHistory, type LocalHistorySnapshot } from "./usage/adapters/token-tracker-local-history"
export { readMachineAgentUsage } from "./usage/adapters/token-tracker-usage-limits"
export { createUsageOutboxSync, type UsageOutboxSync } from "./usage/outbox-sync"
export { LocalUsageRoutes, UsageRoutes, type UsageLedger } from "@claxedo/server-core/usage/routes"
export { createUsageQuotaReader } from "@claxedo/server-core/usage/quota"

export {
  provisionRegisteredWorktree,
  releaseRegisteredWorktree,
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
export { dropCopiedHarnessLogins } from "./credentials/operations/drop-copied-harness-logins"
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

// Verified caller stamping for an embedded machine request.
export { embeddedRelayHostAuthFromActor, EMBEDDED_RELAY_HOST_AUTH_HEADER } from "./workspace/runtime-dispatch/embedded-relay-host-auth"
