import type { SessionConfigUpdate } from "@claxedo/agent-runtime-contract"
import type {
  AgentAgent,
  AgentCommand,
  AgentConfigOption,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentSession,
  AgentTurnOutcome,
  PromptDelivery,
  PromptDeliveryRequest,
  PromptFormat,
  PromptInput,
  PromptModel,
} from "@claxedo/agent-runtime-contract"
import type { CompatEvent } from "./compat-events"
import type { AgentRuntimeEvent as RuntimeStreamEvent } from "@claxedo/agent-event-runtime"
export type { AgentRuntimeTurnStartInput as AgentRuntimeStoreTurnStartInput } from "./runtime-store"
import type {
  AgentHarnessId,
  AgentHarnessTransport,
  SessionHarness,
  SessionModelGroup,
} from "@claxedo/agent-runtime-contract"

export type {
  AgentAgent,
  AgentCommand,
  AgentConfigOption,
  AgentContentPart,
  AgentExecutionBinding,
  AgentMessage,
  AgentMessageAuthor,
  AgentPermission,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentSession,
  AgentTurnOutcome,
  AgentWorkspaceIdentity,
  ClientResult,
  ExecutionAvailability,
  ModelSelection,
  PromptDelivery,
  PromptDeliveryRequest,
  PromptFormat,
  PromptInput,
  PromptModel,
} from "@claxedo/agent-runtime-contract"
export { connectionIdForHarness, isAgentMessage, isProviderUnavailable } from "@claxedo/agent-runtime-contract"
export { isRuntimeGoalStatus, RUNTIME_GOAL_STATUSES } from "@claxedo/agent-event-runtime"
export type { RuntimeGoalSnapshot, RuntimeGoalStatus } from "@claxedo/agent-event-runtime"
export {
  GOAL_ACTIONS,
  GOAL_OPTIONAL_FIELDS,
  GoalCapabilityError,
  goalActionAvailable,
  goalCapabilities,
  requireGoalAction,
}
  from "./capabilities"
export type { HarnessCapabilities, HarnessCapabilityTarget } from "./capabilities"
export type { CompatEvent, CompatEnvelope, CompatPart } from "./compat-events"
export { classifyFirstTurnError, firstTurnErrorData, FIRST_TURN_ERROR_CLASSES } from "./first-turn-error"
export type { FirstTurnErrorClass } from "./first-turn-error"
export type {
  ConnectionSecretLease,
  ConnectionSecretResolver,
  ConnectionReadiness,
  HarnessConnectionCapabilities,
  HarnessConnectionDescriptor,
  HarnessConnectionRef,
} from "./connection-provider"
export { defaultSessionModel, resolveSessionModel, resolveTurnSystem } from "./session-model"
export { renderSessionHandoff, renderSessionTranscript } from "./session-handoff"
export {
  AUTO_LEVEL_ORDER,
  comparePermissionLevels,
  isAutoLevel,
  isPermissionCeilingError,
  narrowerPermissionLevel,
  permissionCeilingAdmits,
  PermissionCeilingError,
  permissionModeLevel,
  widestPermissionModeUnder,
} from "./permission-ceiling"
export { chunk, live, recovering } from "./status"
export type { StatusChunk, StatusCompat, StatusRecover } from "./status"
export {
  AGENT_HARNESS_ACCESSES,
  AGENT_HARNESS_DEFINITIONS,
  AGENT_HARNESS_IDS,
  AGENT_HARNESS_KEYS,
  harnessDefinition,
  HARNESS_EFFORT_LEVELS,
  HARNESS_INSTRUCTION_CHANNELS,
  harnessEffortVerdict,
  harnessKey,
  isAcpConnectionId,
  isAgentHarnessAccess,
  isAgentHarnessId,
  isHarnessEffortLevel,
  NO_HARNESS_EFFORT,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
  parseSessionModelGroup,
  parseStoredSessionModelGroup,
  sessionModelGroupJson,
} from "@claxedo/agent-runtime-contract"
export {
  liveProviderBinding,
  providerBinding,
  providerProjection,
  providerProjectionKey,
  providerProjectionRecord,
  projectionRenewalDue,
  projectionRenewalDueAt,
  ProviderCredentialUnavailableError,
  ProviderProjectionExpiredError,
} from "./provider-projection"
export type {
  AgentHarnessAccess,
  AgentHarnessDefinition,
  AgentHarnessId,
  AgentHarnessKey,
  AgentHarnessTransport,
  HarnessEffortLevel,
  HarnessEffortLevels,
  HarnessEffortVerdict,
  HarnessInstructionChannel,
  HarnessModelEffort,
  NativeHarnessId,
  NativeSdkHarnessId,
  SessionHarness,
  SessionHarnessId,
  SessionModelGroup,
  SessionModelGroupParse,
} from "@claxedo/agent-runtime-contract"
export {
  admitSessionInstructions,
  SESSION_INSTRUCTIONS_MAX_BYTES,
  sessionInstructionsByteLength,
} from "./session-instructions"
export type { SessionInstructionsRefusal } from "./session-instructions"
/**
 * Fixed at create, so a later edit cannot rewrite what an already-running
 * session was told or delegated under. An update naming one is refused rather
 * than dropped: a caller editing it has no other way to learn nothing happened.
 */
export const IMMUTABLE_SESSION_CONFIG_FIELDS = ["instructions", "group"] as const
export type ImmutableSessionConfigField = (typeof IMMUTABLE_SESSION_CONFIG_FIELDS)[number]

/** Config fields accepted from public session create/update requests.
 * Handoff and accepted permission state are runtime-owned; permission changes
 * must go through the adapter permission-mode or permission-reply operation. */
export type SessionConfigRequestUpdate = Omit<
  SessionConfigUpdate,
  "handoff" | "permissionMode" | "permissionState" | "permissionCeiling" | ImmutableSessionConfigField
>

export type AgentRuntimeStreamEvent = RuntimeStreamEvent | CompatEvent
export type RuntimeDirectory = string | undefined

export { acceptsSessionTitle, boundSessionTitleSource, deriveSessionTitle, extractPromptTitleText, isPlaceholderTitle } from "./session-title"
