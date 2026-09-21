export type {
  AgentHarnessAdapter,
  AgentHarnessAdapterCore,
  AgentHarnessAdapterHealth,
  AgentHarnessAdapterHealthContext,
  AgentInteractionResult,
  AgentGoalMutationFailure,
  AgentGoalMutationResult,
  AgentGoalResource,
  AgentGoalStartInput,
  AgentMessagePage,
  AgentMessagePageInput,
  AgentHarnessAdapterProcessOptions,
  AgentTurnWriteContext,
  AgentConfigOptions,
  AgentHandoffSessionOptions,
  AgentPreparedHandoffSession,
  AgentSessionCreateOptions,
  PermissionDecision,
  ResolvedHarnessModel,
  SupportsCancel,
  SupportsAgents,
  SupportsCommands,
  SupportsConfigOptions,
  SupportsFork,
  SupportsGoals,
  SupportsMessagePages,
  SupportsPermissions,
  SupportsQuestions,
  SupportsRevert,
  SupportsRuntimeConfig,
  SupportsShell,
  SupportsSummarize,
  SupportsTodos,
  SupportsUnrevert,
  ShellCommandInput,
  SummarizeSessionInput,
} from "./adapter-contract"
export { requireGoalResource, resolvedModelFromConfigOptions } from "./adapter-contract"
export { AgentMessagePageError } from "./message-page"
export { AgentHarnessEngineError, isAgentHarnessEngineError } from "./harness-engine-error"
export {
  GOAL_ACTIONS,
  GOAL_OPTIONAL_FIELDS,
  GoalCapabilityError,
  goalActionAvailable,
  goalCapabilities,
  hasAdapterCapability,
  requireGoalAction,
} from "./capabilities"
export type {
  AdapterCapability,
  AdapterCapabilityProvider,
  GoalAction,
  GoalCapabilities,
  GoalOptionalField,
  GoalRecovery,
  RuntimeConfigurableAdapter,
} from "./capabilities"
export {
  AcpHarnessAdapter,
  createACPTransportFactory,
  createStreamableHttpACPTransportFactory,
  createWebSocketACPTransportFactory,
} from "./harnesses/acp"
export type {
  ACPConnection,
  ACPProcessConnection,
  ACPStreamableHttpTransportFactoryOptions,
  ACPStreamableHttpConnection,
  ACPTransport,
  ACPTransportEnv,
  ACPTransportFactory,
  ACPTransportFactoryInput,
  ACPWebSocketTransportFactoryOptions,
  ACPWebSocketConnection,
  AcpHarnessAdapterOptions,
  AcpRuntimeStore,
} from "./harnesses/acp"
export { createAcpConnectionProvider } from "./harnesses/acp/connection-provider"
export type { AcpConnectionProviderConfig } from "./harnesses/acp/connection-provider"
export { ACP_RECOVER } from "./harnesses/acp/recovery"
export { ClaudeHarnessAdapter } from "./harnesses/claude"
export type { ClaudeHarnessAdapterOptions } from "./harnesses/claude"
export { claudeAuthEnv } from "./harnesses/claude/auth"
export { harnessProjection } from "./harness-projection"
export { CodexHarnessAdapter } from "./harnesses/codex"
export type { CodexHarnessAdapterOptions } from "./harnesses/codex"
export { CursorHarnessAdapter } from "./harnesses/cursor"
export type { CursorHarnessAdapterOptions } from "./harnesses/cursor"
export { PiHarnessAdapter } from "./harnesses/pi"
export type { PiAdapterOptions } from "./harnesses/pi"
export { AgentRuntimeStaleTurnError } from "./harnesses/shared/runtime-store"
export type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"
