import type { ElicitationPatternEvaluator } from "@claxedo/agent-runtime-contract"
import type { BrokerPorts } from "@claxedo/harness/broker"
import type { Clock } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"
import type { RuntimeEventPublishers } from "../projection/runtime-event-hub"
import { resolveChildRoute } from "../projection/child-routes"
import { BrokerAuthority } from "./authority"
import { BrokerBackgroundWork } from "./background-work"
import { admitChildSession, bindChildCorrelation } from "./child-sessions"
import { BrokerEventDelivery } from "./delivery"
import { BrokerProviderTurns, type LeasedTurnFailure } from "./provider-turns"
import { BrokerRequestRows } from "./request-rows"
import { BrokerSessionEvents } from "./session-events"
import { BrokerSessionState } from "./session-state"

export type { LeasedTurnFailure } from "./provider-turns"

type TimerHandle = ReturnType<typeof setTimeout>

export type StoreBrokerPortOptions = {
  ownerGeneration: string
  patternEvaluator: ElicitationPatternEvaluator
  publishers: RuntimeEventPublishers
  reportOwnerFailure(sessionId: string, error: unknown): void
  /** Retains a refused terminal under its lease; `false` when no owner could take it, and the caller releases the lease instead. */
  retainLeasedTurnFailure(sessionId: string, turn: LeasedTurnFailure, error: unknown): boolean
  clock?: Clock
}

export function createStoreBrokerPorts(store: RuntimeStore, options: StoreBrokerPortOptions): BrokerPorts & {
  abortProviderTurn(sessionId: string): void
  readonly backgroundWork: Pick<BrokerBackgroundWork, "read" | "retireAll" | "activeSessions">
} {
  const authority = new BrokerAuthority(store, options.ownerGeneration)
  const delivery = new BrokerEventDelivery(store, options.publishers)
  const requests = new BrokerRequestRows(store, delivery)
  const backgroundWork = new BrokerBackgroundWork(store, delivery)
  const events = new BrokerSessionEvents(store, delivery, backgroundWork)
  const state = new BrokerSessionState(store, delivery)
  const timers = new Map<unknown, TimerHandle>()
  const clock: Clock = options.clock ?? {
    now: () => Date.now(),
    setTimeout: (callback, ms) => {
      const handle = setTimeout(() => { timers.delete(handle); callback() }, ms)
      timers.set(handle, handle)
      return handle
    },
    clearTimeout: (handle) => {
      const timer = timers.get(handle)
      if (!timer) return
      clearTimeout(timer)
      timers.delete(handle)
    },
  }
  const providerTurns = new BrokerProviderTurns(store, events, delivery, clock,
    (sessionId, error) => options.reportOwnerFailure(sessionId, error),
    (sessionId, turn, error) => options.retainLeasedTurnFailure(sessionId, turn, error))
  return {
    clock,
    services: { patternEvaluator: options.patternEvaluator },
    currentTurnAuthority: (sessionId) => authority.currentTurnAuthority(sessionId),
    sessionAuthority: (sessionId) => authority.sessionAuthority(sessionId),
    turnOpen: (sessionId, turnId) => authority.turnOpen(sessionId, turnId),
    readStart: (sessionId) => authority.readStart(sessionId),
    readPending: (scope) => requests.readPending(scope),
    persistAnswer: (pending, answer, automatic, grant) => requests.persistAnswer(pending, answer, automatic, grant),
    readAnswer: (sessionId, requestId) => requests.readAnswer(sessionId, requestId),
    publish: (event, pending) => requests.publish(event, pending),
    readPermissionState: (sessionId) => state.readPermissionState(sessionId),
    readGoal: (sessionId) => state.readGoal(sessionId),
    publishGoal: (sessionId, snapshot) => state.publishGoal(sessionId, snapshot),
    admitProviderTurn: (sessionId, input, run, closing) => providerTurns.admit(sessionId, input, run, closing),
    drainProviderEvent: (sessionId, turn, event) => {
      providerTurns.observe(turn.turnId, event)
      return events.drainProviderEvent(sessionId, turn.assistantMessageId, event)
    },
    drainChildEvent: (sessionId, event) => events.drainChildEvent(sessionId, event),
    publishSessionEvent: (sessionId, event, assistantMessageId) => events.publishSessionEvent(sessionId, event, assistantMessageId),
    meterUsage: (usage) => events.meterUsage(usage),
    subagentAdmissionStore: store,
    bindChildCorrelation: (parentSessionId, correlationKey, childSessionId) =>
      bindChildCorrelation(store, parentSessionId, correlationKey, childSessionId),
    childRoute: (parentSessionId, correlationKey) => resolveChildRoute(store, parentSessionId, correlationKey),
    admitChildSession: (parentSessionId, childSessionId, observation) =>
      admitChildSession(store, parentSessionId, childSessionId, observation),
    publishSubagent: (parentSessionId, event) => events.publishSubagent(parentSessionId, event),
    publishSubagentDiagnostic: (parentSessionId, diagnostic) => events.publishSubagentDiagnostic(parentSessionId, diagnostic),
    rebind: (sessionId, upstreamSessionId) => authority.rebind(sessionId, upstreamSessionId),
    config: (sessionId) => state.config(sessionId),
    reportOwnerFailure: (sessionId, error) => options.reportOwnerFailure(sessionId, error),
    abortProviderTurn: (sessionId) => providerTurns.abort(sessionId),
    backgroundWork,
  }
}
