import type { ElicitationPatternEvaluator } from "@claxedo/agent-runtime-contract"
import type { BrokerPorts } from "@claxedo/harness/broker"
import type { Clock } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"
import type { RuntimeEventPublishers } from "../projection/runtime-event-hub"
import { BrokerAuthority } from "./authority"
import { admitChildSession, bindChildCorrelation } from "./child-sessions"
import { BrokerEventDelivery } from "./delivery"
import { BrokerProviderTurns } from "./provider-turns"
import { BrokerRequestRows } from "./request-rows"
import { BrokerSessionEvents } from "./session-events"
import { BrokerSessionState } from "./session-state"

type TimerHandle = ReturnType<typeof setTimeout>

export type StoreBrokerPortOptions = {
  ownerGeneration: string
  patternEvaluator: ElicitationPatternEvaluator
  publishers: RuntimeEventPublishers
  reportOwnerFailure(sessionId: string, error: unknown): void
  clock?: Clock
}

export function createStoreBrokerPorts(store: RuntimeStore, options: StoreBrokerPortOptions): BrokerPorts & {
  abortProviderTurn(sessionId: string): void
} {
  const authority = new BrokerAuthority(store, options.ownerGeneration)
  const delivery = new BrokerEventDelivery(store, options.publishers)
  const requests = new BrokerRequestRows(store, delivery)
  const events = new BrokerSessionEvents(store, delivery)
  const state = new BrokerSessionState(store, delivery)
  const providerTurns = new BrokerProviderTurns(store, events, delivery)
  const timers = new Map<unknown, TimerHandle>()
  return {
    clock: options.clock ?? {
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
    },
    services: { patternEvaluator: options.patternEvaluator },
    currentTurnAuthority: (sessionId) => authority.currentTurnAuthority(sessionId),
    readStart: (sessionId) => authority.readStart(sessionId),
    readPending: (scope) => requests.readPending(scope),
    persistAnswer: (pending, answer, automatic, grantKey) => requests.persistAnswer(pending, answer, automatic, grantKey),
    readAnswer: (sessionId, requestId) => requests.readAnswer(sessionId, requestId),
    publish: (event, pending) => requests.publish(event, pending),
    readPermissionState: (sessionId) => state.readPermissionState(sessionId),
    readGoal: (sessionId) => state.readGoal(sessionId),
    publishGoal: (sessionId, snapshot) => state.publishGoal(sessionId, snapshot),
    admitProviderTurn: (sessionId, input, run) => providerTurns.admit(sessionId, input, run),
    drainProviderEvent: (sessionId, turn, event) => {
      providerTurns.observe(turn.turnId, event)
      return events.drainProviderEvent(sessionId, turn.assistantMessageId, event)
    },
    publishSessionEvent: (sessionId, event) => events.publishSessionEvent(sessionId, event),
    meterUsage: (usage) => events.meterUsage(usage),
    subagentAdmissionStore: store,
    bindChildCorrelation: (parentSessionId, correlationKey, childSessionId) =>
      bindChildCorrelation(store, parentSessionId, correlationKey, childSessionId),
    admitChildSession: (parentSessionId, childSessionId, observation) =>
      admitChildSession(store, parentSessionId, childSessionId, observation),
    publishSubagent: (parentSessionId, event) => events.publishSubagent(parentSessionId, event),
    publishSubagentDiagnostic: (parentSessionId, diagnostic) => events.publishSubagentDiagnostic(parentSessionId, diagnostic),
    rebind: (sessionId, upstreamSessionId) => authority.rebind(sessionId, upstreamSessionId),
    persistHandoff: (sessionId, context) => authority.persistHandoff(sessionId, context),
    config: (sessionId) => state.config(sessionId),
    reportOwnerFailure: (sessionId, error) => options.reportOwnerFailure(sessionId, error),
    abortProviderTurn: (sessionId) => providerTurns.abort(sessionId),
  }
}
