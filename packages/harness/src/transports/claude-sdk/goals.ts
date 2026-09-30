import type { AgentGoalMutationResult, RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { ProviderTurnSettlement, SessionBroker, TurnBroker, TurnInput, TurnRef } from "../../contract"
import { nativeGoalPrompt } from "../../contract"
import { claudeGoalNotCleared } from "./errors"
import { configuredChoice, type ClaudeEntry, type ClaudeTurns } from "./turns"

const CLEAR_LIMIT_MS = 30_000

type Running = { turnId: string; stopped: boolean; settled: Promise<RuntimeGoalSnapshot | null> }

function goalTurn(entry: ClaudeEntry, broker: TurnBroker, turn: TurnRef, text: string): TurnInput {
  const { model, effort, system, agent } = configuredChoice(entry)
  return { turnId: turn.turnId, userMessageId: turn.assistantMessageId, assistantMessageId: turn.assistantMessageId, todos: [],
    origin: broker.origin, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(system ? { system } : {}),
    prompt: { agent: agent ?? "", assistantMessageId: turn.assistantMessageId, parts: [{ type: "text", text }] } }
}

export class ClaudeGoals {
  private readonly running = new Map<string, Running>()
  private readonly reported = new Map<string, (goal: RuntimeGoalSnapshot) => void>()
  private readonly closed = new Set<string>()

  constructor(private readonly turns: ClaudeTurns) {}

  watch(sessionId: string, broker: SessionBroker): SessionBroker {
    return { ...broker, goal: { ...broker.goal, publish: async (goal) => {
      await broker.goal.publish(goal)
      if (goal) this.reported.get(sessionId)?.(goal)
    } } }
  }

  async start(entry: ClaudeEntry, objective: string): Promise<AgentGoalMutationResult> {
    const { sessionId } = entry.input
    if (this.running.has(sessionId)) return { ok: false, status: "conflict", message: "Claude Goal is running" }
    let accept!: (result: AgentGoalMutationResult) => void
    const accepted = new Promise<AgentGoalMutationResult>((resolve) => { accept = resolve })
    this.reported.set(sessionId, (goal) => accept({ ok: true, goal }))
    const admitted = await entry.broker.admitProviderTurn({ reason: "goal" }, (broker, turn) =>
      this.turns.run(entry, goalTurn(entry, broker, turn, nativeGoalPrompt(objective)), broker))
    if (!admitted.admitted) {
      this.reported.delete(sessionId)
      return { ok: false, status: "conflict", message: `Claude Goal admission ${admitted.reason}` }
    }
    const running: Running = { turnId: admitted.turn.turnId, stopped: false, settled: admitted.settled.then((outcome) => {
      this.reported.delete(sessionId)
      accept({ ok: false, status: "failed", message: outcome.state === "failed" ? outcome.error : "Claude ended before reporting the Goal" })
      return this.settle(entry, running, running.stopped ? { state: "cancelled" } : outcome)
    }) }
    this.running.set(sessionId, running)
    const release = () => { if (this.running.get(sessionId) === running) this.running.delete(sessionId) }
    void running.settled.then(release, (error: unknown) => {
      release()
      entry.broker.reportFailure(error)
    })
    return await accepted
  }

  async stop(entry: ClaudeEntry): Promise<AgentGoalMutationResult> {
    const running = this.running.get(entry.input.sessionId)
    if (running) {
      running.stopped = true
      await this.turns.cancel(entry, { turnId: running.turnId, assistantMessageId: running.turnId }, { at: Date.now() + CLEAR_LIMIT_MS, signal: new AbortController().signal })
      const goal = await running.settled
      return goal?.status === "paused" ? { ok: true, goal } : { ok: false, status: "failed", message: goal?.lastReason ?? "Claude Goal did not stop" }
    }
    const goal = entry.broker.goal.read()
    if (!goal) return { ok: false, status: "not_found", message: "Claude Goal is absent" }
    const stopped = await this.ended(entry, goal, "paused")
    return stopped.status === "paused" ? { ok: true, goal: stopped } : { ok: false, status: "failed", message: stopped.lastReason ?? "Claude Goal did not stop" }
  }

  forget(sessionId: string): void {
    this.closed.add(sessionId)
  }

  private async settle(entry: ClaudeEntry, running: Running, outcome: ProviderTurnSettlement): Promise<RuntimeGoalSnapshot | null> {
    const goal = entry.broker.goal.read()
    if (goal?.status !== "active" || this.closed.has(entry.input.sessionId)) return goal
    if (outcome.state === "completed") {
      this.pauseWhenIdle(entry, running.turnId)
      return goal
    }
    return this.ended(entry, outcome.state === "failed" ? { ...goal, lastReason: outcome.error } : goal,
      outcome.state === "cancelled" ? "paused" : "blocked")
  }

  private pauseWhenIdle(entry: ClaudeEntry, turnId: string): void {
    const live = entry.live
    void (live?.ended ?? Promise.resolve()).then(async () => {
      const goal = entry.broker.goal.read()
      const running = this.running.get(entry.input.sessionId)
      if (goal?.status !== "active" || (running && running.turnId !== turnId) || (entry.live && entry.live !== live)) return
      await entry.broker.goal.publish({ ...goal, status: "paused", updatedAt: Date.now() })
    }).then(undefined, (error: unknown) => entry.broker.reportFailure(error))
  }

  private async ended(entry: ClaudeEntry, goal: RuntimeGoalSnapshot, status: "paused" | "blocked"): Promise<RuntimeGoalSnapshot> {
    let next: RuntimeGoalSnapshot = { ...goal, status, updatedAt: Date.now() }
    try {
      await this.clear(entry)
    } catch (error) {
      next = { ...goal, status: "blocked", updatedAt: Date.now(), lastReason: [goal.lastReason, errorMessage(error)].filter(Boolean).join("; ") }
    }
    await entry.broker.goal.publish(next)
    return next
  }

  private async clear(entry: ClaudeEntry): Promise<void> {
    if (entry.session.binding.upstreamSessionId.startsWith("claude-sdk:")) throw claudeGoalNotCleared("Claude Goal has no native session to clear")
    const result = await this.turns.command(entry, nativeGoalPrompt("clear"), CLEAR_LIMIT_MS)
    if (result?.type !== "result" || result.subtype !== "success" || result.is_error || result.num_turns !== 0) {
      throw claudeGoalNotCleared("Claude did not confirm clearing the native Goal")
    }
  }
}
