import type {
  AgentExecutionBinding,
  AgentPresentationEvent,
  AgentSessionStartBinding,
  AgentSessionStart,
  RuntimeGoalSnapshot,
  SessionConfig,
  SessionHandoff,
  SubagentObservation,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, RuntimeDiagnostic, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime/contracts"
import type {
  ChildSessionRef,
  OutsideTurnUsage,
  PendingRequest,
  RequestScope,
  ProviderTurnInput,
  ProviderTurnResult,
  RequestAnswer,
} from "../contract/broker"
import type { Clock, HarnessServices } from "../contract/services"
import type { RoutedEvent, TurnOrigin } from "../contract/session"

export type TurnAuthority = AgentExecutionBinding & {
  ownerGeneration: string
  turnId: string
}

export type BrokerEvent = AgentPresentationEvent | {
  type: "permission.auto-answered"
  sessionId: string
  requestId: string
  grantKey: string
}

export type AdmittedSubagentObservation = {
  parentSessionId: string
  observationId: string
  event: SubagentUpdatedEvent
  published: boolean
}

export type SubagentAdmissionStore = {
  admit(input: {
    parentSessionId: string
    observation: SubagentObservation
    allocateKey: () => string
    allocateChildSessionId?: () => string
  }): AdmittedSubagentObservation
  markPublished(parentSessionId: string, observationId: string): void
}

export interface BrokerPorts {
  readonly clock: Clock
  readonly services: Pick<HarnessServices, "patternEvaluator">
  currentTurnAuthority(sessionId: string): TurnAuthority | undefined
  readStart(sessionId: string): AgentSessionStart | undefined
  readPending(scope: RequestScope): readonly PendingRequest[]
  persistAnswer(pending: PendingRequest, answer: RequestAnswer, automatic: boolean, grantKey?: string): Promise<readonly AgentRuntimeEvent[]>
  readAnswer(sessionId: string, requestId: string): RequestAnswer | undefined
  publish(event: BrokerEvent): Promise<void>
  readPermissionState(sessionId: string): Record<string, unknown> | undefined
  readGoal(sessionId: string): RuntimeGoalSnapshot | null
  publishGoal(sessionId: string, snapshot: RuntimeGoalSnapshot | null): Promise<void>
  admitProviderTurn(
    sessionId: string,
    input: ProviderTurnInput,
    run: (turnId: string, signal: AbortSignal) => Promise<void>,
  ): Promise<ProviderTurnResult>
  drainProviderEvent(sessionId: string, turnId: string, event: RoutedEvent): Promise<void>
  meterUsage(usage: OutsideTurnUsage): void
  readonly subagentAdmissionStore: SubagentAdmissionStore
  admitChildSession(parentSessionId: string, childSessionId: string, observation: SubagentObservation): Promise<ChildSessionRef>
  publishSubagent(parentSessionId: string, event: SubagentUpdatedEvent): Promise<void>
  publishSubagentDiagnostic(parentSessionId: string, diagnostic: RuntimeDiagnostic): Promise<void>
  rebind(sessionId: string, upstreamSessionId: string): Promise<void>
  persistHandoff(sessionId: string, context: SessionHandoff): Promise<void>
  config(sessionId: string): SessionConfig
  reportOwnerFailure(sessionId: string, error: unknown): void
}

export type SessionBrokerContext = {
  sessionId: string
  directory: string
  workspaceId: string
  origin: TurnOrigin
  expiresAt?: number
} & ({ start?: undefined; connectionId?: undefined; operationId?: undefined } | {
  start: AgentSessionStartBinding
  connectionId: string
  operationId: string
})

export type TurnBrokerContext = {
  authority: TurnAuthority
  origin: TurnOrigin
  signal: AbortSignal
  expiresAt?: number
}
