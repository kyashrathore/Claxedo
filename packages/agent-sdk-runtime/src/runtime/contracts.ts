import { asRecord } from "@claxedo/agent-runtime-contract"
import type { SessionHarness, SessionModelGroup } from "@claxedo/agent-runtime-contract"
import type {
  AgentRuntimeStreamEvent,
  PromptInput,
  PromptModel,
  RuntimeDirectory,
} from "../index"
import type { AgentHarnessAdapter } from "../adapter-contract"
import type { CompatEvent } from "../compat-events"
import type { RuntimeEventHub } from "../runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"

/**
 * The store a runtime runs on. It states exactly what the runtime calls,
 * recovery and owner operations included, so a caller-supplied store fails to
 * typecheck rather than failing at the first recovery path.
 */
export type AgentRuntimeStore = AgentRuntimeStoreWithRecovery

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
  store: AgentRuntimeStore
  eventHub: RuntimeEventHub
}

/**
 * A harness a runtime can create adapters from. It states the creation the
 * runtime performs, so a factory that cannot serve it fails to typecheck rather
 * than at the first session.
 */
export type AgentHarnessFactory = {
  id: SessionHarness["id"]
  access: SessionHarness["access"]
  create(context: AgentHarnessFactoryContext): AgentHarnessAdapter
}

export type CreateAgentRuntimeInput = {
  store: AgentRuntimeStore
  harnesses: AgentHarnessFactory[]
  /** Caller-owned adapters may be shared by other runtimes and are never disposed here. */
  adapterOwnership?: "runtime" | "caller"
  resolveHarness?: (harness: SessionHarness) => AgentHarnessAdapter | Promise<AgentHarnessAdapter>
  subscriberBufferSize?: number
  /** Per-subscriber authorization gate; requires each subscriber to carry an identity. */
  eventDelivery?: AgentRuntimeEventDeliveryPolicy
}

export type AgentRuntimeSubscriptionIdentity = {
  connectionId: string
  actorId: string
  actorKind: "human" | "agent"
  orgId: string
  workspaceId: string
  role: "viewer" | "editor" | "admin" | "owner"
  /** Opaque signed proof forwarded only to the host's authorization policy. */
  credential?: string
}

export type AgentRuntimeEventDeliveryPolicy = (input: {
  identity: AgentRuntimeSubscriptionIdentity
  event: AgentRuntimeEventEnvelope
}) => "deliver" | "omit" | "terminate" | Promise<"deliver" | "omit" | "terminate">

export type AgentRuntimeEventEnvelope = {
  sessionId: string
  directory: RuntimeDirectory
  payload: AgentRuntimeStreamEvent
}

export type AgentRuntimeSubscribeInput = {
  sessionId?: string
  directory?: RuntimeDirectory
  identity?: AgentRuntimeSubscriptionIdentity
  /**
   * In-process host subscription (e.g. the prompt turn driver reading its own
   * session's events to project and publish them). Exempt from the
   * `eventDelivery` identity requirement and from per-event delivery
   * filtering: the host process owns the store outright, and this flag is
   * reachable only from code running inside it — every network subscriber
   * comes through an HTTP route that builds an `identity` from the request
   * and cannot set this. Without the exemption, composing an
   * `eventDelivery` policy silently killed every local prompt turn: the
   * driver's identityless subscription threw at subscribe time and the turn
   * died before `turn.start`.
   */
  hostInternal?: boolean
}

export type AgentRuntimeSessionCreateInput = {
  id?: string
  workspaceId: string
  directory: RuntimeDirectory
  harness: SessionHarness
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  /** Retained standing instructions; refused by a harness with no instruction channel. */
  instructions?: string
  /** Retained resolved model group; runtime metadata, never sent to the harness. */
  group?: SessionModelGroup
  title?: string
}

type AgentRuntimeTurnActor =
  | { actorId: string; actorKind: "human" | "agent" }
  | { actorId?: never; actorKind?: never }

export type AgentRuntimeTurnStartInput = {
  sessionId: string
  /** Runs after this turn wins the per-session admission and before harness work starts. */
  onAdmitted?: () => void
  text?: string
  parts?: PromptInput["parts"]
  messageId?: string
  assistantMessageId?: string
  agent?: string
  model?: PromptModel
  tools?: Record<string, boolean>
  format?: PromptInput["format"]
  system?: string
  permissionMode?: string
  variant?: string
  author?: PromptInput["author"]
  /** Host-owned durable admission fence checked before producer mutations. */
  admission?: { valid(): boolean; fencingToken(): number }
} & AgentRuntimeTurnActor

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
  if (error instanceof AgentRuntimeGoalError) return true
  const code = asRecord(error)?.code
  return typeof code === "string" && code.startsWith("goal_")
}

export const AGENT_RUNTIME_TURN_CONFLICT_CODE = "session_turn_in_progress"

export class AgentRuntimeTurnAdmissionError extends Error {
  readonly code = AGENT_RUNTIME_TURN_CONFLICT_CODE
  readonly status = 409

  constructor(readonly sessionId: string) {
    super("Session is already processing a message")
    this.name = "AgentRuntimeTurnAdmissionError"
  }
}

export function isAgentRuntimeTurnAdmissionError(error: unknown): error is AgentRuntimeTurnAdmissionError {
  return error instanceof AgentRuntimeTurnAdmissionError || (
    !!error && typeof error === "object" &&
    (error as { code?: unknown }).code === AGENT_RUNTIME_TURN_CONFLICT_CODE
  )
}
