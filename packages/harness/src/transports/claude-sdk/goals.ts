import { AbortError, type SDKActiveGoalMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentGoalMutationResult } from "@claxedo/agent-runtime-contract"
import type { HarnessSession, ProviderTurnSettlement, RoutedEvent, SessionBroker, StartInput, TurnBroker, TurnRef } from "../../contract"
import { nativeGoalPrompt } from "../../contract"
import { claudeStreamEndedWithoutResult } from "./errors"
import { ClaudeProcess } from "./process"
import { ClaudeQueryLauncher } from "./query-options"
import { observeClaudeSessionMessage } from "./session-events"
import { claudeTranslator, translateClaude } from "./events"
import { ClaudeMirroredUsage } from "./mirrored-usage"
import { errorMessage } from "@claxedo/helpers"

type Running = { turnId: string; abort: AbortController; settled: Promise<ProviderTurnSettlement> }

export type ClaudeGoalEntry = { session: HarnessSession; input: StartInput }

export class ClaudeGoals {
  private readonly running = new Map<string, Running>()

  constructor(private readonly launcher: ClaudeQueryLauncher) {}

  async start(entry: ClaudeGoalEntry, broker: SessionBroker, objective: string): Promise<AgentGoalMutationResult> {
    const { input } = entry
    if (this.running.has(input.sessionId)) return { ok: false, status: "conflict", message: "Claude Goal is running" }
    const abort = new AbortController()
    let accept!: (result: AgentGoalMutationResult) => void
    const accepted = new Promise<AgentGoalMutationResult>((resolve) => { accept = resolve })
    const reporting: SessionBroker = { ...broker, goal: { ...broker.goal, publish: async (goal) => {
      await broker.goal.publish(goal)
      if (goal) accept({ ok: true, goal })
    } } }
    const admitted = await broker.admitProviderTurn({ reason: "goal" }, (turnBroker, turn) =>
      this.run(entry, reporting, turnBroker, turn, nativeGoalPrompt(objective), abort))
    if (!admitted.admitted) return { ok: false, status: "conflict", message: `Claude Goal admission ${admitted.reason}` }
    const running = { turnId: admitted.turn.turnId, abort, settled: admitted.settled }
    this.running.set(input.sessionId, running)
    void admitted.settled.then(async (outcome) => {
      if (this.running.get(input.sessionId) === running) this.running.delete(input.sessionId)
      accept({ ok: false, status: "failed", message: outcome.state === "failed" ? outcome.error : "Claude ended before reporting the Goal" })
      const goal = broker.goal.read()
      if (goal?.status === "active" && outcome.state !== "completed") await broker.goal.publish({ ...goal,
        status: outcome.state === "cancelled" ? "paused" : "blocked", updatedAt: Date.now(),
        ...(outcome.state === "failed" ? { lastReason: outcome.error } : {}) })
    })
    return await accepted
  }

  async stop(entry: ClaudeGoalEntry, broker: SessionBroker): Promise<AgentGoalMutationResult> {
    const running = this.running.get(entry.input.sessionId)
    if (running) { running.abort.abort(); await running.settled }
    const goal = broker.goal.read()
    if (!goal) return { ok: false, status: "not_found", message: "Claude Goal is absent" }
    if (entry.session.binding.upstreamSessionId.startsWith("claude-sdk:")) return { ok: false, status: "failed", message: "Claude Goal has no native session to clear" }
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 30_000)
    try {
      let confirmed = false
      for await (const _event of this.run(entry, broker, undefined, undefined, nativeGoalPrompt("clear"), abort, true, () => { confirmed = true })) {}
      if (!confirmed) throw new Error("Claude did not confirm clearing the native Goal")
      const paused = { ...goal, status: "paused" as const, updatedAt: Date.now() }
      await broker.goal.publish(paused)
      return { ok: true, goal: paused }
    } catch (error) {
      const blocked = { ...goal, status: "blocked" as const, updatedAt: Date.now(), lastReason: errorMessage(error) }
      await broker.goal.publish(blocked)
      return { ok: false, status: "failed", message: blocked.lastReason }
    } finally { clearTimeout(timeout) }
  }

  async cancel(sessionId: string): Promise<ProviderTurnSettlement | undefined> {
    const running = this.running.get(sessionId)
    if (running) { running.abort.abort(); return running.settled }
    return undefined
  }

  turnId(sessionId: string): string | undefined { return this.running.get(sessionId)?.turnId }

  private async *run(entry: ClaudeGoalEntry, broker: SessionBroker, turnBroker: TurnBroker | undefined, turn: TurnRef | undefined,
    prompt: string, abort: AbortController, clear = false, confirm?: () => void): AsyncIterable<RoutedEvent> {
    const assistantMessageId = turn?.assistantMessageId ?? entry.session.binding.sessionId
    const { runtime, tasks } = claudeTranslator(assistantMessageId)
    const mirroredUsage = new ClaudeMirroredUsage(runtime, { broker, assistantMessageId, directory: entry.input.directory })
    const processes = new Set<ClaudeProcess>()
    const onAbort = () => abort.abort()
    if (turnBroker?.signal.aborted) onAbort()
    else turnBroker?.signal.addEventListener("abort", onAbort, { once: true })
    const stream = await this.launcher.launch({ session: entry.session, input: entry.input, broker, turnBroker, prompt, abort, processes, mirroredUsage,
      ...(turn ? { turnId: turn.turnId } : {}), clear })
    let sawResult = false
    let stopped = false
    try {
      for await (const message of stream as AsyncIterable<SDKMessage | SDKActiveGoalMessage>) {
        const observed = await observeClaudeSessionMessage(message, entry, broker, abort.signal)
        if (observed.kind === "active-goal") continue
        const current = observed.message
        if (current.type === "result") { sawResult = true; mirroredUsage.release() }
        if (clear) {
          if (current.type === "result" && current.subtype === "success" && !current.is_error && current.num_turns === 0) {
            confirm?.()
          }
          continue
        }
        if (turnBroker) for (const event of await translateClaude(current, runtime, tasks, turnBroker)) yield event
      }
      if (!sawResult && !abort.signal.aborted) throw claudeStreamEndedWithoutResult()
      stopped = !sawResult
    } catch (error) {
      if (!abort.signal.aborted || !(error instanceof AbortError)) throw error
      stopped = true
    } finally {
      mirroredUsage.release()
      turnBroker?.signal.removeEventListener("abort", onAbort)
      stream.close()
      await Promise.all([...processes].map((child) => child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })))
    }
    if (stopped && turnBroker) yield { event: { type: "finish", sessionId: entry.session.binding.sessionId } }
  }
}
