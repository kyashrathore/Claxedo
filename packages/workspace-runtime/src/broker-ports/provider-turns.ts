import { randomUUID } from "node:crypto"
import type { AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { ProviderTurnInput, ProviderTurnResult, ProviderTurnSettlement, TurnRef } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"
import type { BrokerSessionEvents } from "./session-events"
import type { BrokerEventDelivery } from "./delivery"

/** A turn held only by its store lease, whose terminal the store refused: the lease stays held until the session's owner reconciles it. */
export type LeasedTurnFailure = { leaseId: string; assistantMessageId: string; outcome: AgentTurnOutcome }

export class BrokerProviderTurns {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly store: RuntimeStore,
    private readonly events: BrokerSessionEvents,
    private readonly delivery: BrokerEventDelivery,
    private readonly reportOwnerFailure: (sessionId: string, error: unknown) => void,
    private readonly retainLeasedTurnFailure: (sessionId: string, turn: LeasedTurnFailure, error: unknown) => boolean,
  ) {}

  abort(sessionId: string): void {
    this.controllers.get(sessionId)?.abort()
  }

  async admit(
    sessionId: string, input: ProviderTurnInput,
    run: (turn: TurnRef, signal: AbortSignal) => Promise<void>,
  ): Promise<ProviderTurnResult> {
    const session = this.store.getSession(sessionId) as { time?: { archived?: number } } | null
    if (!session || session.time?.archived) return { admitted: false, reason: "closed" }
    const config = this.store.getSessionConfig(sessionId)
    if (!config?.model || !config.agent) throw new Error(`Provider turn ${sessionId} has no resolved model or agent`)
    const leaseId = this.store.acquireTurnLease(sessionId)
    if (!leaseId) return { admitted: false, reason: "busy" }
    const turnId = randomUUID()
    const turn: TurnRef = { turnId, assistantMessageId: turnId }
    const controller = new AbortController()
    try {
      const started = this.store.startTurn({
        sessionId, agentSessionId: this.store.getAgentSessionId(sessionId) ?? undefined,
        assistantMessageId: turnId, agent: config.agent, model: config.model,
        parts: input.userMessage ? [{ type: "text", text: input.userMessage.text }] : [],
        ...(input.userMessage ? { userMessageId: input.userMessage.id } : {}),
      })
      for (const event of started.events) this.delivery.broadcast(sessionId, event)
    } catch (error) {
      this.store.releaseTurnLease(sessionId, leaseId)
      this.reportOwnerFailure(sessionId, error)
      throw error
    }
    this.controllers.set(sessionId, controller)
    const settled: Promise<ProviderTurnSettlement> = Promise.resolve().then(async () => {
      let state: "completed" | "failed" | "cancelled" = "completed"
      let failure: string | undefined
      try {
        await run(turn, controller.signal)
      } catch (error) {
        state = "failed"
        failure = errorMessage(error)
      }
      if (controller.signal.aborted) state = "cancelled"
      const outcome: AgentTurnOutcome = state === "failed"
        ? { status: "failed", error: failure ?? "Provider turn failed", completedAt: Date.now() }
        : { status: state, completedAt: Date.now() }
      let retained = false
      try {
        const finished = this.store.finishTurn({ sessionId, assistantMessageId: turnId, leaseId, outcome })
        for (const event of finished.events) this.delivery.broadcast(sessionId, event)
      } catch (error) {
        state = "failed"
        failure = errorMessage(error)
        retained = this.retainLeasedTurnFailure(sessionId, { leaseId, assistantMessageId: turnId, outcome }, error)
        if (!retained) this.reportOwnerFailure(sessionId, error)
      } finally {
        this.events.releaseProviderTurn(sessionId, turnId)
        this.controllers.delete(sessionId)
        if (!retained) this.store.releaseTurnLease(sessionId, leaseId)
      }
      return state === "failed" ? { state, error: failure ?? "Provider turn failed" } : { state }
    })
    return { admitted: true, turn, settled }
  }
}
