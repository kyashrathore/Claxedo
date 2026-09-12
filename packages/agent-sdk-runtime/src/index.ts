import type {
  AgentAgent,
  AgentCommand,
  AgentConfigOption,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRuntimeEvent,
  AgentSession,
  AgentTurnOutcome,
  PromptFormat,
  PromptInput,
  PromptModel,
} from "@claxedo/agent-runtime-contract"
import type { CompatEvent } from "./compat-events"
import type { AgentRuntimeEvent as RuntimeStreamEvent } from "@claxedo/agent-event-runtime"
import type { AgentHarnessAccess, AgentHarnessId, AgentHarnessTransport, SessionHarnessId } from "./harness-types"

export {
  AGENT_RUNTIME_TURN_CONFLICT_CODE,
  AgentRuntimeTurnConflictError,
  AgentRuntimeTurnConflictError as AgentRuntimeTurnAdmissionError,
  createAgentRuntime,
  isAgentRuntimeTurnConflictError,
  isAgentRuntimeTurnConflictError as isAgentRuntimeTurnAdmissionError,
} from "./runtime"
export type {
  AgentHarnessFactory,
  AgentRuntime,
  AgentRuntimeEventDeliveryPolicy,
  AgentRuntimeEventEnvelope,
  AgentRuntimeGoalErrorCode,
  AgentRuntimeGoalStartInput,
  AgentRuntimeAbortResult,
  AgentRuntimeHealth,
  AgentRuntimeInteractionResult,
  AgentRuntimePermissionDecision,
  AgentRuntimeSessionCreateInput,
  AgentRuntimeSubscribeInput,
  AgentRuntimeSubscriptionIdentity,
  AgentRuntimeStore,
  AgentRuntimeTurnStartInput,
  AgentRuntimeTurnStartResult,
} from "./runtime"
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
  AgentRuntimeEvent,
  AgentSession,
  AgentTurnOutcome,
  AgentWorkspaceIdentity,
  ClientResult,
  ExecutionAvailability,
  ModelSelection,
  PromptFormat,
  PromptInput,
  PromptModel,
} from "@claxedo/agent-runtime-contract"
export { connectionIdForHarness, isAgentMessage } from "@claxedo/agent-runtime-contract"
export { AgentRuntimeGoalError, isAgentRuntimeGoalError } from "./runtime"
export { isRuntimeGoalStatus, RUNTIME_GOAL_STATUSES } from "@claxedo/agent-event-runtime"
export type { RuntimeGoalSnapshot, RuntimeGoalStatus } from "@claxedo/agent-event-runtime"
export {
  GOAL_ACTIONS,
  GOAL_OPTIONAL_FIELDS,
  GoalCapabilityError,
  goalActionAvailable,
  goalCapabilities,
  harnessCapabilities,
  requireGoalAction,
}
  from "./capabilities"
export type {
  GoalAction,
  GoalCapabilities,
  GoalOptionalField,
  GoalRecovery,
  HarnessCapabilities,
  HarnessCapabilityTarget,
} from "./capabilities"
export { requireGoalResource } from "./adapter-contract"
export type {
  AgentConfigOptions,
  AgentPermissionMode,
  AgentPermissionModeState,
  AutoLevel,
  ResolvedHarnessModel,
  AgentGoalMutationFailure,
  AgentGoalMutationResult,
  AgentGoalResource,
  AgentGoalStartInput,
  SupportsGoals,
} from "./adapter-contract"
export type { CompatEvent, CompatEnvelope, CompatPart } from "./compat-events"
export { classifyFirstTurnError, firstTurnErrorData, FIRST_TURN_ERROR_CLASSES } from "./first-turn-error"
export type { FirstTurnErrorClass } from "./first-turn-error"
export {
  ConnectionProviderError,
  createConnectionProviderRegistry,
} from "./connection-provider"
export { createAcpConnectionProvider } from "./harnesses/acp/connection-provider"
export type { AcpConnectionProviderConfig } from "./harnesses/acp/connection-provider"
export type {
  ConnectionGeneration,
  ConnectionProvider,
  ConnectionProviderAdapterContext,
  ConnectionProviderErrorCode,
  ConnectionProviderProjection,
  ConnectionProviderResolution,
  ConnectionSecretLease,
  ConnectionSecretResolver,
  ConnectionReadiness,
  HarnessConnectionCapabilities,
  HarnessConnectionDescriptor,
  HarnessConnectionRef,
} from "./connection-provider"
export { defaultSessionModel, resolveSessionModel, resolveTurnSystem } from "./session-model"
export { renderSessionHandoff } from "./session-handoff"
export {
  createMemorySubagentAdmissionStore,
  createSubagentAdmissionBoundary,
} from "./subagent-admission"
export type {
  AdmittedSubagentObservation,
  SubagentAdmissionBoundary,
  SubagentAdmissionStore,
  SubagentObservation,
} from "./subagent-admission"
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
  harnessKey,
  isAcpConnectionId,
  isAgentHarnessAccess,
  isAgentHarnessId,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
} from "./harness-types"
export { modelConfigOption } from "./sdk-model-options"
export type { SdkModelEntry } from "./sdk-model-options"
export { harnessEffortLevels, harnessEffortVerdict, NO_HARNESS_EFFORT } from "./harness-effort"
export type { HarnessEffortLevels, HarnessEffortVerdict, HarnessModelEffort } from "./harness-effort"
export {
  isSessionGroupSlot,
  parseSessionModelGroup,
  parseStoredSessionModelGroup,
  SESSION_GROUP_SLOTS,
  sessionModelGroupJson,
} from "./session-group"
export type {
  SessionGroupEntry,
  SessionGroupSlot,
  SessionModelGroup,
  SessionModelGroupParse,
} from "./session-group"
export { createLiveModelSource } from "./live-model-source"
export type { LiveModelSource } from "./live-model-source"
export type {
  AgentHarnessAccess,
  AgentHarnessDefinition,
  AgentHarnessId,
  AgentHarnessKey,
  AgentHarnessTransport,
  NativeHarnessId,
  NativeSdkHarnessId,
  SessionHarnessId,
} from "./harness-types"
export {
  AGENT_PROCESS_ATTRIBUTION_SCENARIOS,
  observeAgentProcess,
  safeAgentProcessDescriptor,
  type AgentProcessCapabilities,
  type AgentProcessAttributionScenario,
  type AgentProcessConfidence,
  type AgentProcessDescriptor,
  type AgentProcessLifecycle,
  type AgentProcessLocality,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
  type AgentProcessRole,
} from "./process-observer"

export type SessionHarness = {
  /** A built-in harness id, or a configured connection id. */
  id: SessionHarnessId
  access: AgentHarnessAccess
}

export type SessionConfig = {
  /** Host-owned maximum permission level, retained across harness changes. */
  permissionCeiling?: import("./adapter-contract").AutoLevel
  /** Accepted harness mode, persisted by the permission-mode operation. */
  permissionMode?: string
  /** Native permission state accepted by the driver; opaque to shared consumers. */
  permissionState?: Record<string, unknown>
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  /**
   * Standing instructions this session was created with. They reach the harness
   * through its instruction channel at the head of every turn, so a session
   * reopened after a restart keeps them without the caller resending anything,
   * and nothing meant as instruction arrives as user text.
   */
  instructions?: string | null
  /**
   * The resolved model group this session was created under, machine-readable
   * so a later reader — a delegation request naming a slot, say — resolves the
   * same harness/model/effort the creator chose instead of re-parsing the
   * instruction prose the group was also rendered into.
   */
  group?: import("./session-group").SessionModelGroup | null
  handoff?: { from: SessionHarness; pending: true; transcript: string } | null
}

/**
 * Partial update for a session config.
 *
 * - `undefined` leaves a field unchanged.
 * - `null` clears optional nullable fields.
 * - a value replaces the field.
 *
 * `harness` is a full replacement, not a deep merge.
 */
export type SessionConfigUpdate = {
  permissionCeiling?: SessionConfig["permissionCeiling"]
  permissionMode?: string | null
  permissionState?: Record<string, unknown> | null
  harness?: SessionHarness
  model?: PromptModel | null
  variant?: string | null
  agent?: string | null
  instructions?: string | null
  group?: import("./session-group").SessionModelGroup | null
  handoff?: { from: SessionHarness; pending: true; transcript: string } | null
}

/** Config fields accepted from public session create/update requests.
 * Handoff and accepted permission state are runtime-owned; permission changes
 * must go through the adapter permission-mode or permission-reply operation.
 * Instructions and the model group are fixed at create so a later edit cannot
 * rewrite what an already-running session was told or delegated under. */
export type SessionConfigRequestUpdate = Omit<SessionConfigUpdate, "handoff" | "permissionMode" | "permissionState" | "permissionCeiling" | "instructions" | "group">

export type AgentRuntimeStreamEvent = RuntimeStreamEvent | CompatEvent
export type RuntimeDirectory = string | undefined
