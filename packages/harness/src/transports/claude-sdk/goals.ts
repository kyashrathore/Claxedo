import type { SDKActiveGoalMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentGoalMutationResult } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, RoutedEvent, SessionBroker, StartInput, TurnBroker } from "../../contract"
import { ClaudeProcess } from "./process"
import { ClaudeQueryLauncher } from "./query-options"
import { observeClaudeSessionMessage } from "./session-events"
import { claudeTranslator, translateClaude } from "./translate"

type Running = { turnId: string; abort: AbortController; settled: Promise<unknown> }

export class ClaudeGoals {
  private readonly running = new Map<string, Running>()

  constructor(private readonly launcher: ClaudeQueryLauncher) {}

  async start(session: HarnessSession, input: StartInput, broker: SessionBroker, objective: string): Promise<AgentGoalMutationResult> {
    if (this.running.has(input.sessionId)) return { ok: false, status: "conflict", message: "Claude Goal is running" }
    const abort = new AbortController()
    const admitted = await broker.admitProviderTurn({ reason: "goal" }, (turnBroker) => this.run(session, input, broker, turnBroker, `/goal ${objective}`, abort))
    if (!admitted.admitted) return { ok: false, status: "conflict", message: `Claude Goal admission ${admitted.reason}` }
    const running = { turnId: admitted.turnId, abort, settled: admitted.settled }
    this.running.set(input.sessionId, running)
    void admitted.settled.then(async (outcome) => {
      if (this.running.get(input.sessionId) === running) this.running.delete(input.sessionId)
      const goal = broker.goal.read()
      if (goal?.status === "active" && outcome.state !== "completed") await broker.goal.publish({ ...goal,
        status: outcome.state === "cancelled" ? "paused" : "blocked", updatedAt: Date.now(),
        ...(outcome.state === "failed" ? { lastReason: outcome.error } : {}) })
    })
    return { ok: true, goal: broker.goal.read() }
  }

  async stop(session: HarnessSession, input: StartInput, broker: SessionBroker): Promise<AgentGoalMutationResult> {
    const running = this.running.get(input.sessionId)
    if (running) { running.abort.abort(); await running.settled }
    const goal = broker.goal.read()
    if (!goal) return { ok: false, status: "not_found", message: "Claude Goal is absent" }
    if (session.binding.upstreamSessionId.startsWith("claude-sdk:")) return { ok: false, status: "failed", message: "Claude Goal has no native session to clear" }
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 30_000)
    try {
      let confirmed = false
      for await (const _event of this.run(session, input, broker, undefined, "/goal clear", abort, true, () => { confirmed = true })) {}
      if (!confirmed) throw new Error("Claude did not confirm clearing the native Goal")
      const paused = { ...goal, status: "paused" as const, updatedAt: Date.now() }
      await broker.goal.publish(paused)
      return { ok: true, goal: paused }
    } catch (error) {
      const blocked = { ...goal, status: "blocked" as const, updatedAt: Date.now(), lastReason: error instanceof Error ? error.message : String(error) }
      await broker.goal.publish(blocked)
      return { ok: false, status: "failed", message: blocked.lastReason }
    } finally { clearTimeout(timeout) }
  }

  async cancel(sessionId: string): Promise<void> {
    const running = this.running.get(sessionId)
    if (running) { running.abort.abort(); await running.settled }
  }

  turnId(sessionId: string): string | undefined { return this.running.get(sessionId)?.turnId }

  private async *run(session: HarnessSession, input: StartInput, broker: SessionBroker, turnBroker: TurnBroker | undefined,
    prompt: string, abort: AbortController, clear = false, confirm?: () => void): AsyncIterable<RoutedEvent> {
    const { runtime, tasks } = claudeTranslator(session.binding.sessionId)
    const processes = new Set<ClaudeProcess>()
    const stream = await this.launcher.launch({ session, input, broker, turnBroker, prompt, abort, processes, runtime,
      assistantMessageId: session.binding.sessionId, clear })
    try {
      for await (const message of stream as AsyncIterable<SDKMessage | SDKActiveGoalMessage>) {
        const observed = await observeClaudeSessionMessage(message, session, broker, abort.signal)
        if (observed.kind === "active-goal") continue
        const current = observed.message
        if (clear) {
          if (current.type === "result" && current.subtype === "success" && !current.is_error && current.num_turns === 0) {
            confirm?.()
          }
          continue
        }
        if (turnBroker) for (const event of await translateClaude(current, runtime, tasks, turnBroker)) yield event
      }
    } finally {
      stream.close()
      await Promise.all([...processes].map((child) => child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })))
    }
  }
}
