export { createWorkGraph, WorkGraphClient } from "./client";
export type { ClientExecutor, Interrupt, InterruptKind, ItemFilter, LaunchInput, LaunchResult, PolicyRule, StageOptions, SyncBackPolicy } from "./client";
export { github, linear, jira, custom, nativeConnector, type ConnectionSpec, type ConnectionQuery } from "./connectors/index";
export type { ConnectorInterface, NormalizedIssue } from "./connectors/interface";
export { createApp, initializeDb } from "./app";
export { registerWorkGraphTools } from "./mcp";
export { normalizeRemote, inferRepo, resolveRepoDir, type RepoBinding, type RepoBindingResolver, type RepoBucket } from "./repo";
export {
  startAttempts,
  onAttemptStatusUpdate,
  onSessionStopped,
  onPlannerStopped,
  cancelAttempt,
  reconcileAttempts,
  resetAttemptState,
  // Back-compat aliases for the pre-flat executor names.
  cancelAttempt as cancelNodeExecution,
  reconcileAttempts as reconcileExecution,
  type SpawnAgentFn,
  type RunMetrics,
  type RunPhase,
} from "./sdk/attempts";
export type { ExecutionAdapter, ExecutionCleanup, ExecutionHandle, ExecutionLaunch } from "./execution";
export { openSqliteExecutionStore, type IExecutionStore } from "./sdk/execution-store";
export { openSqliteEventStore } from "./substrate/event-store-sqlite";
