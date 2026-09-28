import { asRecord } from "@claxedo/agent-runtime-contract"
import type {
  AgentSessionStartBinding,
  RecoveryBudgets,
  RecoveryError,
  RecoveryFacts,
  RecoveryOperation,
  RecoveryOutcome,
  RecoveryRequest,
  RecoveryTurnTarget,
  SessionConfig,
  SessionHarness,
  SessionModelGroup,
  SteerResult,
} from "@claxedo/agent-runtime-contract"
import type {
  AgentRuntimeStreamEvent,
  ConnectionSecretAuthority,
  PromptDelivery,
  PromptDeliveryRequest,
  PromptInput,
  PromptModel,
  RuntimeDirectory,
} from "@claxedo/agent-sdk-runtime"
import type { CompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import type { TurnActor, TurnOrigin } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"
import type { LaunchComposer } from "./launch"
import type { TransportResolver } from "./transports"

/**
 * The store a runtime host runs on. The broker ports read its SQLite tables
 * directly, so the host takes the concrete store rather than a narrowed shape.
 */
export type AgentRuntimeStore = RuntimeStore

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

/**
 * Who is asking. `callerId` scopes request-id uniqueness, so two callers may
 * reuse one request id without joining each other's operation; `authority` is
 * the widest target scope this caller may act on.
 */
export type RecoveryCaller = {
  callerId: string
  authority: "session" | "workspace" | "machine"
}

/**
 * What the runtime owner knows about one session right now, answered without
 * awaiting that session's admission, producer or store transaction — a session
 * whose turn is wedged is exactly the one a caller needs this for.
 */
export type AgentRuntimeRecoveryInspection = {
  sessionId: string
  /** The admitted turn a caller sends back unchanged in a mutating request. */
  target?: RecoveryTurnTarget
  facts: RecoveryFacts
  health: AgentRuntimeHealth
  /** Owner failures that are retained because nothing has resolved them yet. */
  failures: RecoveryError[]
  operations: RecoveryOperation[]
  /** Prompts parked on this session's admission queue. */
  queued: number
}

export type AgentRuntimeRecovery = {
  inspect(sessionId: string, directory?: RuntimeDirectory): AgentRuntimeRecoveryInspection
  submit(request: RecoveryRequest, caller: RecoveryCaller): Promise<RecoveryOutcome>
  read(operationId: string, caller: RecoveryCaller): RecoveryOutcome | undefined
  /**
   * A containment attempt that never became an operation, because submitting it
   * failed. There is no receipt to read it back by, so the owner retains it
   * against the session and `inspect` is where it is answered.
   */
  reportContainmentFailure(target: RecoveryTurnTarget, caller: RecoveryCaller, message: string): void
  /**
   * A failure a transport observed while serving one session — an interaction it
   * could not project or answer, a terminal its store refused. The caller that
   * triggered it gets its own error; this is where it stays visible to the
   * session's owner after that caller has gone.
   */
  reportOwnerFailure: (sessionId: string, error: unknown) => void
}

export type CreateAgentRuntimeInput = {
  store: AgentRuntimeStore
  eventHub: RuntimeEventHub
  transports: TransportResolver
  launch: LaunchComposer
  subscriberBufferSize?: number
  /**
   * Who this runtime is on the wire. A session's own workspace id comes from
   * its execution binding; this supplies the machine, and the workspace for a
   * session that has no binding yet. Absent leaves both out of a recovery
   * target rather than inventing one, and `recovery.inspect` says so.
   */
  identity?: { workspaceId: string; machineId?: string }
  /** Deadlines and the clock recovery runs on; defaults are the contract's. */
  recovery?: { budgets?: Partial<RecoveryBudgets>; now?: () => number }
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
  workspaceId: string
  directory: RuntimeDirectory
  harness: SessionHarness
  /** Whose accounts the session spends, for every turn anyone sends on it. */
  owner: TurnActor
  origin: TurnOrigin
  /** The reservation this create runs under, when the caller holds one. */
  start?: AgentSessionStartBinding
  parentID?: string
  model?: PromptModel
  variant?: string | null
  agent?: string | null
  /** Retained standing instructions; refused by a harness with no instruction channel. */
  instructions?: string
  /** Retained resolved model group; runtime metadata, never sent to the harness. */
  group?: SessionModelGroup
  permissionCeiling?: SessionConfig["permissionCeiling"]
  title?: string
  /** The proof the create request was admitted under; the connection's secrets are leased with it. */
  secretAuthority?: ConnectionSecretAuthority
}

type AgentRuntimeTurnActor =
  | { actorId: string; actorKind: "human" | "agent" }
  | { actorId?: never; actorKind?: never }

export type AgentRuntimeTurnStartInput = {
  sessionId: string
  origin: TurnOrigin
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
  /** `null` asks for the harness's default effort, overriding a level the session saved. */
  variant?: string | null
  serviceTier?: string
  author?: PromptInput["author"]
  /**
   * What to do when a turn is already running for this session. Absent takes
   * the admission conflict.
   */
  delivery?: PromptDeliveryRequest
  /**
   * Host-owned durable admission fence checked before producer mutations.
   * `proof` is the signed turn lease it holds, which the turn's connection
   * secrets are leased under.
   */
  admission?: { valid(): boolean; fencingToken(): number; proof(): string }
} & AgentRuntimeTurnActor

export type AgentRuntimeTurnStartResult = {
  sessionId: string
  userMessageId: string
  /** The turn this prompt joined: the running turn's when it steered it. */
  assistantMessageId: string
  directory: RuntimeDirectory
  prompt: PromptInput
  delivery: PromptDelivery
  steering?: SteerResult
  /**
   * The turn this prompt may later ask the runtime to cancel. A queued prompt
   * has none: the turn holding the session belongs to another caller, and
   * naming it here would let a lease loss on this prompt stop that one.
   */
  target?: RecoveryTurnTarget
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

export type RequestRefusalKind = "stale" | "duplicate" | "foreign" | "unoffered" | "persistence"

/** A request answer the broker refused, carrying the broker's own reason and whether a retry can change it. */
export class AgentRuntimeRequestRefusedError extends Error {
  readonly code = "request_refused"

  constructor(readonly refusal: RequestRefusalKind, readonly retryable: boolean, message: string) {
    super(message)
    this.name = "AgentRuntimeRequestRefusedError"
  }
}

export function isAgentRuntimeRequestRefusedError(error: unknown): error is AgentRuntimeRequestRefusedError {
  return error instanceof AgentRuntimeRequestRefusedError
}
