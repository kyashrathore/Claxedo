import type { AgentGoalMutationResult, RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, ProviderTurnSettlement, RoutedEvent, SessionBroker, TurnBroker } from "../../contract"

type Running = { turnId: string; abort: AbortController; settled: Promise<ProviderTurnSettlement>; broker: SessionBroker; stopped: boolean }

export type GoalRun = (turnBroker: TurnBroker, prompt: string) => AsyncIterable<RoutedEvent>

function settledStatus(outcome: ProviderTurnSettlement): RuntimeGoalSnapshot["status"] {
  if (outcome.state === "completed") return "complete"
  return outcome.state === "cancelled" ? "paused" : "blocked"
}

export class CursorGoals {
  private readonly running = new Map<string, Running>()

  async start(session: HarnessSession, broker: SessionBroker, objective: string, run: GoalRun): Promise<AgentGoalMutationResult> {
    const sessionId = session.binding.sessionId
    if (this.running.has(sessionId)) return { ok: false, status: "conflict", message: "Cursor Goal is running" }
    const abort = new AbortController()
    const admitted = await broker.admitProviderTurn({ reason: "goal" }, (turnBroker) =>
      run({ ...turnBroker, signal: AbortSignal.any([turnBroker.signal, abort.signal]) }, `/goal ${objective}`))
    if (!admitted.admitted) return { ok: false, status: "conflict", message: `Cursor Goal admission ${admitted.reason}` }
    const now = Date.now()
    const goal: RuntimeGoalSnapshot = { sessionId, objective, status: "active", createdAt: now, updatedAt: now }
    await broker.goal.publish(goal)
    const running: Running = { turnId: admitted.turnId, abort, settled: admitted.settled, broker, stopped: false }
    this.running.set(sessionId, running)
    void admitted.settled.then((outcome) => this.settle(sessionId, running, outcome)).catch((error: unknown) => broker.reportFailure(error))
    return { ok: true, goal }
  }

  private async settle(sessionId: string, running: Running, outcome: ProviderTurnSettlement): Promise<void> {
    if (this.running.get(sessionId) === running) this.running.delete(sessionId)
    if (running.stopped) return
    const goal = running.broker.goal.read()
    if (goal?.status !== "active") return
    await running.broker.goal.publish({ ...goal, status: settledStatus(outcome), updatedAt: Date.now(),
      ...(outcome.state === "failed" ? { lastReason: outcome.error } : {}) })
  }

  async interrupt(sessionId: string): Promise<ProviderTurnSettlement | undefined> {
    const running = this.running.get(sessionId)
    if (!running) return undefined
    running.stopped = true
    running.abort.abort()
    const outcome = await running.settled
    const goal = running.broker.goal.read()
    if (goal?.status === "active") await running.broker.goal.publish({ ...goal, status: "paused", updatedAt: Date.now() })
    return outcome
  }

  turnId(sessionId: string): string | undefined { return this.running.get(sessionId)?.turnId }

  async stop(session: HarnessSession, broker: SessionBroker): Promise<AgentGoalMutationResult> {
    await this.interrupt(session.binding.sessionId)
    const goal = broker.goal.read()
    if (!goal) return { ok: false, status: "not_found", message: "Cursor Goal is absent" }
    const paused = goal.status === "paused" ? goal : { ...goal, status: "paused" as const, updatedAt: Date.now() }
    if (paused !== goal) await broker.goal.publish(paused)
    return { ok: true, goal: paused }
  }

  async delete(session: HarnessSession, broker: SessionBroker): Promise<AgentGoalMutationResult<null>> {
    await this.interrupt(session.binding.sessionId)
    if (!broker.goal.read()) return { ok: false, status: "not_found", message: "Cursor Goal is absent" }
    await broker.goal.publish(null)
    return { ok: true, goal: null }
  }
}
