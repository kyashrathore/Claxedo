import type {
  AgentRuntimeStreamEvent,
  PromptInput,
  PromptModel,
  RuntimeDirectory,
  SessionHarness,
} from "../index"
import type { AgentHarnessAdapter } from "../adapter-contract"
import type { CompatEvent } from "../compat-events"
import type { RuntimeEventHub } from "../runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"

declare const agentRuntimeStore: unique symbol
declare const agentHarnessFactory: unique symbol

export type AgentRuntimeStore = {
  readonly [agentRuntimeStore]: true
}

export type RuntimeStoreInternal = AgentRuntimeStoreWithRecovery
export type InternalAgentHarnessFactory = {
  id: SessionHarness["id"]
  access: SessionHarness["access"]
  create(context: AgentHarnessFactoryContext): AgentHarnessAdapter
}

export type AgentRuntimeAbortResult =
  | { ok: true; status: "cancelled" | "already_idle" }
  | { ok: false; status: "not_found" | "recovering" | "failed"; message: string }

export type AgentRuntimePermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"

export type AgentRuntimeInteractionResult = {
  events: CompatEvent[]
}

export type AgentRuntimeHealth = {
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  message?: string
  sessions?: Array<{
    id: string
    status?: string | null
    message?: string | null
  }>
}

export type AgentHarnessFactoryContext = {
  store: RuntimeStoreInternal
  eventHub: RuntimeEventHub
}

export type AgentHarnessFactory = {
  id: SessionHarness["id"]
  access: SessionHarness["access"]
  readonly [agentHarnessFactory]: true
}

export type CreateAgentRuntimeInput = {
  store: AgentRuntimeStore
  harnesses: AgentHarnessFactory[]
  resolveHarness?: (harness: SessionHarness) => AgentHarnessAdapter | Promise<AgentHarnessAdapter>
  subscriberBufferSize?: number
}

export type AgentRuntimeEventEnvelope = {
  sessionId: string
  directory: RuntimeDirectory
  payload: AgentRuntimeStreamEvent
}

export type AgentRuntimeSubscribeInput = {
  sessionId?: string
  directory?: RuntimeDirectory
}

export type AgentRuntimeSessionCreateInput = {
  id?: string
  directory: RuntimeDirectory
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  title?: string
}

export type AgentRuntimeTurnStartInput = {
  sessionId: string
  text?: string
  parts?: unknown[]
  messageId?: string
  assistantMessageId?: string
  agent?: string
  model?: PromptModel
  tools?: Record<string, boolean>
  format?: PromptInput["format"]
  system?: string
  permissionMode?: string
  variant?: string
}

export type AgentRuntimeTurnStartResult = {
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  directory: RuntimeDirectory
  prompt: PromptInput
}

export type AgentRuntimeGoalStartInput = {
  sessionId: string
  objective: string
}

export type AgentRuntimeGoalErrorCode =
  | "goal_invalid_objective"
  | "goal_session_not_found"
  | "goal_scope_mismatch"
  | "goal_unavailable"
  | "goal_already_exists"
  | "goal_action_unavailable"

export class AgentRuntimeGoalError extends Error {
  constructor(
    readonly code: AgentRuntimeGoalErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AgentRuntimeGoalError"
  }
}

export function isAgentRuntimeGoalError(error: unknown): error is AgentRuntimeGoalError {
  return error instanceof AgentRuntimeGoalError || (
    !!error && typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("goal_")
  )
}

export class AgentRuntimeTurnAdmissionError extends Error {
  readonly code = "turn_already_active"

  constructor(readonly sessionId: string) {
    super("Session is already processing a message")
    this.name = "AgentRuntimeTurnAdmissionError"
  }
}

export function isAgentRuntimeTurnAdmissionError(error: unknown): error is AgentRuntimeTurnAdmissionError {
  return error instanceof AgentRuntimeTurnAdmissionError || (
    !!error && typeof error === "object" &&
    (error as { code?: unknown }).code === "turn_already_active"
  )
}
