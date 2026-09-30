import type {
  AgentPermission,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentSessionStartBinding,
  PermissionDecision,
  RuntimeGoalSnapshot,
  SessionConfig,
  SessionHandoff,
  SubagentObservation,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import type { HarnessBinding, RoutedEvent, TurnOrigin, TurnRef } from "./session"

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"

export type PermissionOption = {
  optionId: string
  kind: PermissionOptionKind
  name: string
}

export type ChildRequestRoute = { correlationKey: string }

type RequestIdentity = { requestId: string; child?: ChildRequestRoute; expiresAt?: number }

export type PermissionRequest = RequestIdentity & {
  kind: "permission"
  permission: AgentPermission
  options?: readonly PermissionOption[]
  grantKey?: string
}

export type QuestionRequest = RequestIdentity & {
  kind: "question"
  question: AgentQuestion
}

export type ElicitationRequest = RequestIdentity & {
  kind: "elicitation"
  elicitationId?: string
  mode: "form" | "url"
  message: string
  schema?: unknown
  url?: string
}

export type TurnRequest = PermissionRequest | QuestionRequest | ElicitationRequest

export type RequestAnswer =
  | { kind: "permission"; decision: PermissionDecision; optionId?: string }
  | { kind: "answers"; answers: readonly AgentQuestionAnswer[] }
  | { kind: "form"; values: Readonly<Record<string, unknown>> }
  | { kind: "consent"; accepted: boolean }
  | { kind: "rejected" }
  | { kind: "cancelled" }
  | { kind: "expired" }

export type PermissionReply = { kind: "permission"; decision: PermissionDecision } | { kind: "permission"; optionId: string }

export type RequestReply = Exclude<RequestAnswer, { kind: "permission" }> | PermissionReply

export type OutsideTurnUsage = {
  sessionId: string
  directory: string
  assistantMessageId: string
  usage: AgentRuntimeEventOf<"usage">
}

export type ChildSessionRef = {
  sessionId: string
  assistantMessageId: string
  created: number
}

export type ProviderTurnInput = {
  reason: "goal" | "provider"
  userMessage?: { id: string; text: string }
}

export type ProviderTurnResult =
  | { admitted: true; turn: TurnRef; settled: Promise<ProviderTurnSettlement> }
  | { admitted: false; reason: "busy" | "closed" }

export type ProviderTurnSettlement = { state: "completed" } | { state: "failed"; error: string } | { state: "cancelled" }

export type OutsideTurnEvent = AgentRuntimeEventOf<
  | "rate-limit" | "auth-status" | "mcp-server-status" | "available-commands-update" | "config-update"
  | "session-info" | "session-title" | "session-agent" | "harness-notice" | "diagnostic" | "background-work"
>

export interface TurnBroker {
  readonly signal: AbortSignal
  readonly origin: TurnOrigin
  ask(request: TurnRequest, options?: { signal?: AbortSignal }): Promise<RequestAnswer>
  completeElicitation(elicitationId: string): Promise<void>
  observeSubagent(observation: SubagentObservation): Promise<ChildSessionRef | undefined>
  associateChild(correlationKey: string, child: ChildSessionRef): void
}

export interface SessionBroker {
  readonly sessionId: string
  ask(request: TurnRequest, options?: { signal?: AbortSignal }): Promise<RequestAnswer>
  completeElicitation(elicitationId: string): Promise<void>
  rebind(upstreamSessionId: string): Promise<HarnessBinding>
  persistHandoff(context: SessionHandoff): Promise<void>
  admitProviderTurn(
    input: ProviderTurnInput,
    run: (broker: TurnBroker, turn: TurnRef) => AsyncIterable<RoutedEvent>,
  ): Promise<ProviderTurnResult>
  meter(usage: OutsideTurnUsage): void
  publish(event: OutsideTurnEvent): Promise<void>
  observeSubagent(observation: SubagentObservation): Promise<ChildSessionRef | undefined>
  associateChild(correlationKey: string, child: ChildSessionRef): void
  publishChild(event: RoutedEvent): Promise<void>
  readonly goal: {
    read(): RuntimeGoalSnapshot | null
    publish(snapshot: RuntimeGoalSnapshot | null): Promise<void>
  }
  config(): SessionConfig
  reportFailure(error: unknown): void
}

export type RequestScope = { sessionId: string } | { directory: string }

export type PendingRequest = {
  sessionId: string
  request: TurnRequest
  askedAt: number
  upstreamSessionId?: string
  start?: AgentSessionStartBinding
}

export type AnswerRefusal = "stale" | "duplicate" | "foreign" | "unoffered" | "persistence"

export type AnswerResult =
  | { ok: true; events: readonly AgentRuntimeEvent[] }
  | { ok: false; refusal: AnswerRefusal; retryable: boolean; message: string }

export interface RequestBroker {
  list(scope: RequestScope): readonly PendingRequest[]
  answer(
    requestId: string,
    reply: RequestReply,
    target: { sessionId: string } | { start: AgentSessionStartBinding },
  ): Promise<AnswerResult>
  closeSession(sessionId: string): void
}
