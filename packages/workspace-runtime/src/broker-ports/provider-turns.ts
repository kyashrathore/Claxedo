import { randomUUID } from "node:crypto"
import { errorMessage } from "@claxedo/helpers"
import type { ProviderTurnInput, ProviderTurnResult, ProviderTurnSettlement } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"
import type { BrokerSessionEvents } from "./session-events"
import type { BrokerEventDelivery } from "./delivery"

export class BrokerProviderTurns {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly store: RuntimeStore,
    private readonly events: BrokerSessionEvents,
    private readonly delivery: BrokerEventDelivery,
  ) {}

  abort(sessionId: string): void {
    this.controllers.get(sessionId)?.abort()
  }

  async admit(
    sessionId: string, input: ProviderTurnInput,
    run: (turnId: string, signal: AbortSignal) => Promise<void>,
  ): Promise<ProviderTurnResult> {
    const session = this.store.getSession(sessionId) as { time?: { archived?: number } } | null
    if (!session || session.time?.archived) return { admitted: false, reason: "closed" }
    const config = this.store.getSessionConfig(sessionId)
    if (!config?.model || !config.agent) throw new Error(`Provider turn ${sessionId} has no resolved model or agent`)
    const leaseId = this.store.acquireTurnLease(sessionId)
    if (!leaseId) return { admitted: false, reason: "busy" }
    const turnId = randomUUID()
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
      throw error
    }
    this.controllers.set(sessionId, controller)
    const settled: Promise<ProviderTurnSettlement> = Promise.resolve().then(async () => {
      let state: "completed" | "failed" | "cancelled" = "completed"
      let failure: string | undefined
      try {
        await run(turnId, controller.signal)
      } catch (error) {
        state = "failed"
        failure = errorMessage(error)
      }
      if (controller.signal.aborted) state = "cancelled"
      try {
        const finished = this.store.finishTurn({
          sessionId, assistantMessageId: turnId, leaseId,
          outcome: state === "failed"
            ? { status: "failed", error: failure ?? "Provider turn failed", completedAt: Date.now() }
            : { status: state, completedAt: Date.now() },
        })
        for (const event of finished.events) this.delivery.broadcast(sessionId, event)
      } catch (error) {
        state = "failed"
        failure = errorMessage(error)
      } finally {
        this.events.releaseProviderTurn(sessionId, turnId)
        this.controllers.delete(sessionId)
        this.store.releaseTurnLease(sessionId, leaseId)
      }
      return state === "failed" ? { state, error: failure ?? "Provider turn failed" } : { state }
    })
    return { admitted: true, turnId, settled }
  }
}
