import { errorMessage } from "@claxedo/helpers"
import { assistantMessageIdForTurn, createMessageIds, type AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { Clock, ProviderTurnInput, ProviderTurnResult, ProviderTurnSettlement, RoutedEvent, TurnRef } from "@claxedo/harness/contract"
import { harnessAuthor, providerTurnNotice } from "./provider-turn-message"
import { resolveSessionModel } from "../session/session-model"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload } from "../host/turn-outcome"
import { sessionTurnAgent } from "../host/turn-record"
import type { RuntimeStore } from "../store"
import type { BrokerSessionEvents } from "./session-events"
import type { BrokerEventDelivery } from "./delivery"

/** How long a provider turn waits for the turn still holding its session to release it before it is refused as busy. */
const ENDING_TURN_RELEASE_WAIT_MS = 30_000

/** A turn held only by its store lease, whose terminal the store refused: the lease stays held until the session's owner reconciles it. */
export type LeasedTurnFailure = { leaseId: string; assistantMessageId: string; outcome: AgentTurnOutcome }

export class BrokerProviderTurns {
  private readonly controllers = new Map<string, AbortController>()
  private readonly streams = new Map<string, { terminal?: boolean; outcome?: AgentTurnOutcome }>()
  private readonly messageIds = createMessageIds()

  constructor(
    private readonly store: RuntimeStore,
    private readonly events: BrokerSessionEvents,
    private readonly delivery: BrokerEventDelivery,
    private readonly clock: Clock,
    private readonly reportOwnerFailure: (sessionId: string, error: unknown) => void,
    private readonly retainLeasedTurnFailure: (sessionId: string, turn: LeasedTurnFailure, error: unknown) => boolean,
  ) {}

  observe(turnId: string, routed: RoutedEvent): void {
    const stream = this.streams.get(turnId)
    if (!stream || routed.route?.kind === "child") return
    stream.terminal ||= isTerminalRuntimePayload(routed.event)
    stream.outcome = mergeOutcome(stream.outcome, outcomeFromPayload(routed.event))
  }

  private outcome(turnId: string): AgentTurnOutcome {
    const stream = this.streams.get(turnId)
    if (stream?.terminal && stream.outcome) return stream.outcome
    return { status: "failed", error: "Harness stream ended without a terminal event", completedAt: Date.now(),
      detail: { code: "missing_terminal_event" } }
  }

  abort(sessionId: string): void {
    this.controllers.get(sessionId)?.abort()
  }

  private closed(sessionId: string): boolean {
    const session = this.store.getSession(sessionId) as { time?: { archived?: number } } | null
    return !session || !!session.time?.archived
  }

  private async leaseOnceReleased(sessionId: string, closing?: AbortSignal): Promise<string | undefined> {
    const bound = new AbortController()
    const timer = this.clock.setTimeout(() => bound.abort(), ENDING_TURN_RELEASE_WAIT_MS)
    const signal = closing ? AbortSignal.any([bound.signal, closing]) : bound.signal
    try { return await this.store.turnLeases.acquireOnRelease(sessionId, signal) }
    finally { this.clock.clearTimeout(timer) }
  }

  async admit(
    sessionId: string, input: ProviderTurnInput,
    run: (turn: TurnRef, signal: AbortSignal) => Promise<void>, closing?: AbortSignal,
  ): Promise<ProviderTurnResult> {
    if (closing?.aborted || this.closed(sessionId)) return { admitted: false, reason: "closed" }
    const config = this.store.getSessionConfig(sessionId)
    if (!config) throw new Error(`Provider turn ${sessionId} has no runtime config`)
    const model = resolveSessionModel(config)
    const leaseId = await this.leaseOnceReleased(sessionId, closing)
    if (!leaseId) return { admitted: false, reason: closing?.aborted ? "closed" : "busy" }
    if (closing?.aborted || this.closed(sessionId)) {
      this.store.releaseTurnLease(sessionId, leaseId)
      return { admitted: false, reason: "closed" }
    }
    if (input.reason === "continuation" && !input.current()) {
      this.store.releaseTurnLease(sessionId, leaseId)
      return { admitted: false, reason: "busy" }
    }
    const messageId = this.messageIds()
    const turnId = input.reason === "continuation" ? messageId : assistantMessageIdForTurn(messageId)
    const turn: TurnRef = { turnId, assistantMessageId: turnId }
    const controller = new AbortController()
    try {
      const opening = input.reason === "continuation"
        ? { parentMessageId: this.store.getLatestUserMessageId(sessionId), parts: [] }
        : { userMessageId: messageId, parts: [{ type: "text" as const, text: providerTurnNotice(input) }], author: harnessAuthor(config.harness.id) }
      if (input.reason === "continuation" && !opening.parentMessageId) {
        throw new Error(`Continuation ${sessionId} has no prompt to answer`)
      }
      const started = this.store.startTurn({
        sessionId, agentSessionId: this.store.getAgentSessionId(sessionId) ?? undefined,
        ...opening, assistantMessageId: turnId, agent: sessionTurnAgent(config), ...(model ? { model } : {}),
      })
      for (const event of started.events) this.delivery.broadcast(sessionId, event)
    } catch (error) {
      this.store.releaseTurnLease(sessionId, leaseId)
      this.reportOwnerFailure(sessionId, error)
      throw error
    }
    this.controllers.set(sessionId, controller)
    this.streams.set(turnId, {})
    const settled: Promise<ProviderTurnSettlement> = Promise.resolve().then(async () => {
      let outcome: AgentTurnOutcome
      try {
        await run(turn, controller.signal)
        outcome = this.outcome(turnId)
      } catch (error) {
        outcome = { status: "failed", error: errorMessage(error), completedAt: Date.now() }
      }
      if (controller.signal.aborted) outcome = { status: "cancelled", completedAt: Date.now() }
      let retained = false
      try {
        const finished = this.store.finishTurn({ sessionId, assistantMessageId: turnId, leaseId, outcome })
        for (const event of finished.events) this.delivery.broadcast(sessionId, event)
      } catch (error) {
        retained = this.retainLeasedTurnFailure(sessionId, { leaseId, assistantMessageId: turnId, outcome }, error)
        if (!retained) this.reportOwnerFailure(sessionId, error)
        outcome = { status: "failed", error: errorMessage(error), completedAt: Date.now() }
      } finally {
        this.streams.delete(turnId)
        this.events.releaseProviderTurn(sessionId, turnId)
        this.controllers.delete(sessionId)
        if (!retained) this.store.releaseTurnLease(sessionId, leaseId)
      }
      return outcome.status === "failed" ? { state: "failed", error: outcome.error } : { state: outcome.status }
    })
    return { admitted: true, turn, settled }
  }
}
