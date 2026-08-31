export type {
  AbortResult,
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
  PermissionDecision,
  SupportsAbort,
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
  SupportsTodos,
  SupportsUnrevert,
} from "./adapter-contract"
export { requireGoalResource } from "./adapter-contract"
export { AgentMessagePageError } from "./message-page"
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
  HttpProxyAdapter,
  RuntimeConfigurableAdapter,
} from "./capabilities"
export {
  AcpHarnessAdapter,
  createHttpACPTransportFactory,
  createStreamableHttpACPTransportFactory,
  createWebSocketACPTransportFactory,
} from "./harnesses/acp"
export type {
  ACPHttpTransportFactoryOptions,
  ACPStreamableHttpTransportFactoryOptions,
  ACPTransport,
  ACPTransportEnv,
  ACPTransportFactory,
  ACPTransportFactoryInput,
  ACPWebSocketTransportFactoryOptions,
  AcpHarnessAdapterOptions,
  AcpRuntimeStore,
} from "./harnesses/acp"
export { ACP_RECOVER } from "./harnesses/acp/recovery"
export { ClaudeHarnessAdapter } from "./harnesses/claude"
export type { ClaudeHarnessAdapterOptions } from "./harnesses/claude"
export { claudeAuthEnv, claudeAuthValue } from "./harnesses/claude/auth"
export { CodexHarnessAdapter } from "./harnesses/codex"
export type { CodexHarnessAdapterOptions } from "./harnesses/codex"
export { CursorHarnessAdapter } from "./harnesses/cursor"
export type { CursorHarnessAdapterOptions } from "./harnesses/cursor"
export { OpenCodeHarnessAdapter, opencodeAuthContent, prepareSpawnEnv, spawnEnv } from "./harnesses/opencode"
export type { OpenCodeRequestFn } from "./harnesses/opencode"
export { PiHarnessAdapter } from "./harnesses/pi"
export type { PiAdapterOptions, PiSessionPlacement } from "./harnesses/pi"
export {
  createPiAgent,
  DEFAULT_PI_SYSTEM_PROMPT,
  evaluatePiGoal,
  piApiKeyBackendResolver,
  PiModelResolutionError,
  requirePiModel,
  refreshPiAgent,
  runPiModelTurn,
  sessionEnvBashTool,
} from "./harnesses/pi/model-backend"
export type {
  PiModelBackend,
  PiModelBackendResolver,
  PiModelBackendResolverInput,
  PiGoalEvaluation,
  PiGoalEvaluator,
  PiGoalEvaluatorInput,
  PiApiKeyBackendOptions,
  PiModelResolutionErrorCode,
  PiModelTurnResult,
} from "./harnesses/pi/model-backend"
export { piModelCatalog } from "./harnesses/pi/catalog"
export type { PiModelCatalogModel, PiModelCatalogProvider } from "./harnesses/pi/catalog"
export type { AgentTool as PiAgentTool } from "@mariozechner/pi-agent-core"
export { localPiCredentialProviders, localPiModelBackendResolver } from "./harnesses/pi/local-auth"
export type { LocalPiAuthOptions } from "./harnesses/pi/local-auth"
export { codexBundlePiBackendResolver, codexBundleToOAuth, firstPiModelBackend } from "./harnesses/pi/bundle-auth"
export type { CodexBundleBackendOptions } from "./harnesses/pi/bundle-auth"
export type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"
