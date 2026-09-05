export {
  createSelfHostedApp,
  createDefaultLocalControlPlaneServices,
  shutdownControlPlaneRuntime,
  startControlPlaneStack,
  type ControlPlaneStackOptions,
} from "./deployments/self-hosted-node/app"
/**
 * The self-hosted binary's one supported way in.
 *
 * `startServer` is deliberately NOT re-exported: it composes without checking
 * the deployment posture, so a caller reaching it would boot a configuration
 * this package refuses. It stays reachable inside the package for
 * `startSelfHostedServer` to call after the gate passes.
 */
export { startSelfHostedServer, selfHostedPosture } from "./deployments/self-hosted-node/start"
export { DEFAULT_CLAXEDO_SERVER_PORT } from "@claxedo/local-server/self-hosted-execution"
export { createCentralSessionRuntime } from "./session/runtime"
export {
  ControlPlaneCompositionError,
  createControlPlaneServices,
  createHostedControlPlaneServices,
  defaultControlPlaneCredentials,
  type ControlPlaneCredentials,
  type ControlPlaneRelay,
  type ControlPlaneSandbox,
  type ControlPlaneServices,
  type ControlPlaneServicesOptions,
  type ControlPlaneTelemetry,
  type ControlPlaneLocalExecution,
  type HostedControlPlaneServicesOptions,
  type WorkspaceAuthority,
} from "./authority/services"
export {
  betterAuthAdapter,
  customVerifierAuthAdapter,
  devAuthAdapter,
  localOnlyAuthAdapter,
  type BetterAuthVerifier,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthAdapter,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
export {
  hostTunnelTokenSigner,
  runtimeAccessTokenSigner,
  type HostTunnelTokenSigner,
  type RuntimeAccessTokenSigner,
} from "@claxedo/server-core/platform/auth/runtime-access-token"
export {
  createControlPlaneRelayProvider,
  type ControlPlaneRelayProviderOptions,
  type RelayProvider,
  type RelayTarget,
  type RelayToken,
  type RelayTokenInput,
} from "@claxedo/server-core/adapters/relay/index"
export {
  DEFAULT_WORKSPACE_RUNTIME_PORT,
  createSandboxManager,
  type SandboxLeaseAcquireInput,
  type SandboxLeaseAcquireResult,
  type SandboxLeasePatch,
  type SandboxLeaseStore,
  type SandboxBootSource,
  type SandboxDriver,
  type SandboxExposure,
  type SandboxDriverEnsureInput,
  type SandboxLease,
  type SandboxLeaseStatus,
  type SandboxManager,
  type SandboxNetworkPolicy,
  type SandboxDriverId,
  type SandboxDriverMetadata,
  type SandboxSource,
  type SandboxTarget,
  type SandboxEnsureResult,
  type SandboxGarbageCollectResult,
  type SandboxManagerInput,
  type SandboxManagerOptions,
  type SandboxMutationResult,
  type SandboxSnapshotManagerResult,
  type SandboxSnapshotResult,
  type SandboxTargetResult,
  type SandboxTouchResult,
} from "@claxedo/sandbox-manager"
export { createMemoryLeaseStore, sandboxLease } from "@claxedo/sandbox-manager/stores/memory"
export { createSqliteLeaseStore } from "./sandbox/stores/sqlite"
export { createCloudflareSandboxDriver, type CloudflareSandboxDriverOptions } from "@claxedo/sandbox-manager/drivers/cloudflare"
export { createDaytonaSandboxDriver, type DaytonaSandboxDriverOptions } from "@claxedo/sandbox-manager/drivers/daytona"
export { createDockerSandboxDriver, type DockerSandboxDriverOptions } from "@claxedo/sandbox-manager/drivers/docker"
export { createModalSandboxDriver, type ModalSandboxDriverOptions } from "@claxedo/sandbox-manager/drivers/modal"
export { createVercelSandboxDriver, type VercelSandboxDriverOptions } from "@claxedo/sandbox-manager/drivers/vercel"
export {
  sandboxDriverCatalog,
  type SandboxDriverCatalogEntry,
} from "@claxedo/sandbox-manager/driver-catalog"
export {
  isSandboxDriverID,
  sandboxDriverIds,
  type SandboxDriverAuth,
  type SandboxDriverConfig,
  type SandboxDriverID,
} from "@claxedo/sandbox-contract"
export type {
  SandboxRowAcquireResult,
  SandboxComputeClass,
  SandboxEpochEnvelope,
  SandboxRowEvent,
  SandboxRowHeartbeatResult,
  SandboxHoldRow,
  SandboxHoldRowOwnerType,
  SandboxLeaseRow,
  SandboxLeaseRowStatus,
  SandboxRowReconnectResult,
} from "@claxedo/sandbox-manager/lease-types"
export {
  RUNTIME_DIR,
  WORKSPACE_RUNTIME_PORT,
  WORKSPACE_DIR,
} from "@claxedo/sandbox-manager/defaults"
export { createProjectionStore, type ProjectionStore } from "./authority/projection-store"
export { createDurableSessionLog, type DurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
export {
  claimChannelDelivery,
  countChannelDeliveriesByUserDay,
  releaseChannelDelivery,
  rememberChannelDeliverySession,
  type ChannelDeliveryClaimInput,
  type ChannelDeliveryDecision,
} from "./channels/delivery"
export {
  channelRunAudit,
  channelRunAudits,
  recordChannelRunAudit,
  type ChannelRunAuditInput,
  type ChannelRunAuditRecord,
} from "./channels/run-audit"
export { createProjectionDedupStore } from "./channels/dedup"
export {
  createMirrorController,
  noopAdapter as noopMirrorAdapter,
  type AuditEntry,
  type MirrorAdapter,
  type MirrorController,
} from "./adapters/central-store/mirror"
export { createClaxedoClient, type ClaxedoClientOptions, type ClaxedoRequestOptions } from "./client"
export {
  startUserHostedWorkspaceTunnel,
  stopAllUserHostedWorkspaceTunnels,
  stopUserHostedWorkspaceTunnel,
} from "./user-hosted-tunnel"
export { initPostHog, shutdownPostHog, capture, getPostHog } from "./platform/telemetry/errors/posthog"
export { claxedoBus } from "@claxedo/server-core/platform/runtime/lib/bus"
export type { ClaxedoEvent, PtyInfo } from "@claxedo/server-core/platform/runtime/lib/bus"
export { Pty, Process, createProcessClient, ProcessManager } from "@claxedo/workspace-runtime/host"
export { ClaxedoDB } from "./platform/db"
export { dataDir, stateDir } from "@claxedo/server-core/platform/runtime/lib/paths"
