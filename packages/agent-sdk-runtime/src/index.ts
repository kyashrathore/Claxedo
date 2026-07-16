import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { CompatEvent } from "./compat-events"
import type { AgentHarnessAccess, AgentHarnessId, AgentHarnessTransport } from "./harness-types"

export {
  createAgentRuntime,
} from "./runtime"
export type {
  AgentHarnessFactory,
  AgentRuntime,
  AgentRuntimeEventEnvelope,
  AgentRuntimeAbortResult,
  AgentRuntimeHealth,
  AgentRuntimeInteractionResult,
  AgentRuntimePermissionDecision,
  AgentRuntimeSessionCreateInput,
  AgentRuntimeSubscribeInput,
  AgentRuntimeStore,
  AgentRuntimeTurnStartInput,
  AgentRuntimeTurnStartResult,
} from "./runtime"
export type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
export { harnessCapabilities }
  from "./capabilities"
export type {
  HarnessCapabilities,
  HarnessCapabilityTarget,
} from "./capabilities"
export type { CompatEvent, CompatEnvelope, CompatPart } from "./compat-events"
export { classifyFirstTurnError, firstTurnErrorData, FIRST_TURN_ERROR_CLASSES } from "./first-turn-error"
export type { FirstTurnErrorClass } from "./first-turn-error"
export { chunk, live, recovering } from "./status"
export type { StatusChunk, StatusCompat, StatusRecover } from "./status"
export {
  AGENT_HARNESS_ACCESSES,
  AGENT_HARNESS_DEFINITIONS,
  AGENT_HARNESS_IDS,
  AGENT_HARNESS_KEYS,
  harnessDefinition,
  harnessKey,
  isAcpHarnessId,
  isAgentHarnessAccess,
  isAgentHarnessId,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
} from "./harness-types"
export {
  SDK_MODEL_CATALOG,
  isSdkModelId,
  requireSdkModelId,
  sdkModelConfigOption,
  sdkModelOptions,
} from "./sdk-model-catalog"
export type { SdkModelCatalog, SdkModelId } from "./sdk-model-catalog"
export type {
  AcpHarnessId,
  AgentHarnessAccess,
  AgentHarnessDefinition,
  AgentHarnessId,
  AgentHarnessKey,
  AgentHarnessTransport,
  AgentHarnessTransportInput,
  NativeHarnessId,
} from "./harness-types"
export {
  createMemoryRunStore,
  type RunStore,
  type RunStoreAppendInput,
  type RunStoreEvent,
  type SessionEnv,
  type SessionEnvExecOptions,
  type SessionEnvExecResult,
  type SessionEnvFactory,
  type SessionEnvFactoryInput,
  type SessionEnvFileStat,
  type SessionHost,
  type SessionStartMode,
  type ResolvedSessionPlacement,
  type SandboxRef,
} from "./session-env"
export { createVirtualSessionEnv } from "./virtual-session-env"

export type PromptModel = {
  providerID: string
  modelID: string
}

export type PromptFormat =
  | { type: "json_schema"; name?: string; schema?: unknown; strict?: boolean; provider_payload?: unknown }
  | { type: string; provider_payload?: unknown; [key: string]: unknown }

export type PromptInput = {
  parts: unknown[]
  userMessageId?: string
  assistantMessageId: string
  agent: string
  model: PromptModel
  tools?: Record<string, boolean>
  format?: PromptFormat
  system?: string
  variant?: string
}

export type ProcessHarnessConnection = {
  kind: "process"
  binary?: string
  args?: string[]
}

export type RemoteHarnessConnection = {
  kind: "remote"
  transport?: AgentHarnessTransport
  url?: string
  headers?: Record<string, string>
}

export type HarnessConnection = ProcessHarnessConnection | RemoteHarnessConnection

export type SessionHarness = {
  id: AgentHarnessId
  access: AgentHarnessAccess
  connection?: HarnessConnection
}

export type SessionConfig = {
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
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
  harness?: SessionHarness
  model?: PromptModel | null
  variant?: string | null
  agent?: string | null
}

export type AgentRuntimeStreamEvent = AgentRuntimeEvent | CompatEvent
export type RuntimeDirectory = string | undefined

export type AgentSession = {
  id: string
  title?: string | null
  slug?: string
  version?: string
  directory?: string
  parentID?: string
  rootID?: string
  projectID?: string
  tags?: unknown[]
  attachments?: unknown[]
  time?: { created: number; updated?: number; archived?: number }
  created_at?: number
  archived_at?: number | null
  status?: string | null
  lastTurn?: AgentTurnOutcome
  harnessPayload?: unknown
}

export type AgentTurnOutcome = (
  | { status: "completed"; completedAt: number; reason?: string }
  | { status: "failed"; completedAt: number; error: string }
  | { status: "cancelled"; completedAt: number; reason?: string }
) & { assistantMessageId?: string }

export type AgentMessage = {
  info: {
    id: string
    role: string
    sessionID?: string
    parentID?: string
    time?: { created?: number; completed?: number }
    providerID?: string
    modelID?: string
    agent?: string
    harnessPayload?: unknown
  }
  parts: unknown[]
  harnessPayload?: unknown
}

export type AgentPermission = {
  id: string
  sessionID: string
  tool?: string
  title?: string
  permission?: string
  patterns?: string[]
  always?: string[]
  metadata?: Record<string, unknown>
  time?: { created?: number }
  harnessPayload?: unknown
}

export type AgentQuestion = {
  id: string
  sessionID: string
  questions?: unknown[]
  harnessPayload?: unknown
}

export type AgentCommand = {
  name: string
  content?: string
  description?: string
  harnessPayload?: unknown
}

export type AgentAgent = {
  name: string
  description?: string
  mode?: string
  harnessPayload?: unknown
}

export type AgentConfigOption = {
  id: string
  name?: string
  type?: string
  category?: string
  currentValue?: unknown
  description?: string
  selectOptions?: Array<{
    id: string
    name?: string
    description?: string
    value?: unknown
    harnessPayload?: unknown
  }>
  harnessPayload?: unknown
}

/** @deprecated use AgentSession. */
export type AgentSessionRow = AgentSession
/** @deprecated use AgentMessage. */
export type AgentMessageRow = AgentMessage
/** @deprecated use AgentPermission. */
export type AgentPermissionRow = AgentPermission
/** @deprecated use AgentQuestion. */
export type AgentQuestionRow = AgentQuestion
/** @deprecated use AgentCommand. */
export type AgentCommandRow = AgentCommand
/** @deprecated use AgentAgent. */
export type AgentAgentRow = AgentAgent
/** @deprecated use AgentConfigOption. */
export type AgentConfigOptionRow = AgentConfigOption
