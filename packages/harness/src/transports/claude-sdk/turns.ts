import { AbortError, type EffortLevel, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { isHarnessEffortLevel, type SteerResult } from "@claxedo/agent-runtime-contract"
import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import type { Deadline, HarnessSession, RoutedEvent, SessionBroker, StartInput, TurnBroker, TurnInput, TurnRef } from "../../contract"
import { TransportError } from "../../contract/errors"
import { claudePrompt } from "./attachments"
import { claudeStreamEndedWithoutResult } from "./errors"
import { claudeTranslator, translateClaude } from "./events"
import { ClaudeLiveQuery, type ClaudeFrame } from "./live-query"
import { ClaudeMirroredUsage } from "./mirrored-usage"
import { type ClaudeModelCatalog, requiredClaudeEffort } from "./models"
import { type ClaudeProcess, retireClaudeProcesses } from "./process"
import type { ClaudeLaunchTurn, ClaudeQueryLauncher } from "./query-options"
import { observeClaudeSessionMessage } from "./session-events"

export type ClaudeEntry = {
  input: StartInput
  revision: number
  session: HarnessSession
  broker: SessionBroker
  processes: Set<ClaudeProcess>
  active?: { id: string; abort: AbortController; live?: ClaudeLiveQuery; launched: boolean }
  provider?: { turnId: string; live: ClaudeLiveQuery }
  turn?: ClaudeLaunchTurn
  live?: ClaudeLiveQuery
  retiring?: { live: ClaudeLiveQuery; done: Promise<void> }
}

function claudeEffort(value: string | null | undefined): EffortLevel | undefined {
  if (!value) return undefined
  if (!isHarnessEffortLevel(value)) throw new TransportError("claude", "configuration", `Unsupported Claude effort ${value}`)
  return value
}

export class ClaudeTurns {
  constructor(private readonly launcher: () => ClaudeQueryLauncher, private readonly models: ClaudeModelCatalog) {}

  async steer(entry: ClaudeEntry, ref: TurnRef, input: TurnInput): Promise<SteerResult> {
    const active = entry.active
    return active?.id === ref.turnId && active.live ? active.live.input.steer(await claudePrompt(input, entry.session.directory), input.userMessageId)
      : { ok: false as const, status: "no_active_turn" as const, message: "Claude turn is idle" }
  }

  async cancel(entry: ClaudeEntry, turn: TurnRef, deadline: Deadline): Promise<AdapterCancelOutcome> {
    if (entry.provider?.turnId === turn.turnId) {
      const { live } = entry.provider
      live.interrupt()
      await retireClaudeProcesses(entry.processes, deadline)
      await live.ended
      return { execution: "unknown", cleanup: "unknown" }
    }
    if (!entry.active || entry.active.id !== turn.turnId) return { execution: "terminal", cleanup: "unknown" }
    entry.active.abort.abort()
    if (!entry.active.launched) return { execution: "terminal", cleanup: "verified_clear" }
    await retireClaudeProcesses(entry.processes, deadline)
    return { execution: "unknown", cleanup: "unknown" }
  }

  async stop(entry: ClaudeEntry): Promise<void> {
    entry.active?.abort.abort()
    entry.live?.interrupt()
    await retireClaudeProcesses(entry.processes)
  }

  private launchKey(entry: ClaudeEntry, turn: TurnInput, model: string, effort: EffortLevel | undefined): string {
    return JSON.stringify([entry.revision, entry.broker.config(), model, effort ?? null, turn.system ?? null, turn.prompt.agent ?? null])
  }

  private async liveFor(entry: ClaudeEntry, turn: TurnInput, abort: AbortController): Promise<{ live: ClaudeLiveQuery; frames: AsyncIterable<ClaudeFrame> } | undefined> {
    const model = turn.model?.modelID ?? "default"
    const effort = claudeEffort(requiredClaudeEffort(turn.effort ? await this.models.load(entry.input, entry.input.sessionId) : [], model, turn.effort))
    const key = this.launchKey(entry, turn, model, effort)
    const current = entry.live
    if (current?.reusable && current.key === key && entry.active && !abort.signal.aborted) {
      const frames = current.claim()
      entry.active.launched = true
      if (frames) return { live: current, frames }
    }
    if (current) {
      current.close()
      await this.retire(entry, current)
    }
    if (abort.signal.aborted || !entry.active) return undefined
    entry.active.launched = true
    const live: ClaudeLiveQuery = new ClaudeLiveQuery(key, () => this.admitOwnTurn(entry, live))
    entry.live = live
    const frames = live.claim()!
    live.run(await this.launcher().launch({ session: entry.session, input: entry.input, broker: entry.broker, turn: () => entry.turn,
      prompt: live.input.stream, abort: live.abort, processes: entry.processes, usage: live.usage,
      model, effort, system: turn.system, agent: turn.prompt.agent, partialMessages: true }))
    void live.ended.then(() => this.retire(entry, live))
    return { live, frames }
  }

  private retire(entry: ClaudeEntry, live: ClaudeLiveQuery): Promise<void> {
    if (entry.retiring?.live === live) return entry.retiring.done
    const done = live.ended.then(async () => {
      if (entry.live === live) entry.live = undefined
      await retireClaudeProcesses(entry.processes)
    })
    entry.retiring = { live, done }
    return done
  }

  private admitOwnTurn(entry: ClaudeEntry, live: ClaudeLiveQuery): void {
    void entry.broker.admitProviderTurn({ reason: "provider" }, (broker, turn) => this.ownTurn(entry, live, broker, turn)).then((admission) => {
      if (!admission.admitted && admission.reason === "closed") live.close()
    }, (error: unknown) => entry.broker.reportFailure(error))
  }

  private async *ownTurn(entry: ClaudeEntry, live: ClaudeLiveQuery, broker: TurnBroker, turn: TurnRef): AsyncIterable<RoutedEvent> {
    const frames = live.claim()
    if (!frames) return
    entry.provider = { turnId: turn.turnId, live }
    entry.turn = { broker, turnId: turn.turnId }
    const onAbort = () => live.interrupt()
    if (broker.signal.aborted) onAbort()
    else broker.signal.addEventListener("abort", onAbort, { once: true })
    try {
      yield* this.translated(entry, live, frames, turn.assistantMessageId, [], broker, broker.signal)
    } finally {
      broker.signal.removeEventListener("abort", onAbort)
      if (entry.provider?.turnId === turn.turnId) entry.provider = undefined
      await this.endTurn(entry, live, turn.turnId, true)
    }
  }

  private async endTurn(entry: ClaudeEntry, live: ClaudeLiveQuery, turnId: string, settled: boolean): Promise<void> {
    if (entry.turn?.turnId === turnId) entry.turn = undefined
    live.release()
    live.input.settle(settled && !live.reusable ? "ended" : "failed")
    if (!live.reusable) await this.retire(entry, live)
  }

  async *run(entry: ClaudeEntry, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    if (entry.active || entry.provider) throw new TransportError("claude", "session", "Claude turn already active")
    const abort = new AbortController()
    const active: NonNullable<ClaudeEntry["active"]> = { id: turn.turnId, abort, launched: false }
    entry.active = active
    abort.signal.addEventListener("abort", () => active.live?.interrupt(), { once: true })
    const onAbort = () => abort.abort()
    if (broker.signal.aborted) onAbort()
    else broker.signal.addEventListener("abort", onAbort, { once: true })
    const aborted = () => entry.active?.abort.signal.aborted === true
    let settled = false
    try {
      if (abort.signal.aborted) return
      const opening = await claudePrompt(turn, entry.input.directory)
      const opened = await this.liveFor(entry, turn, abort)
      if (!opened) return
      active.live = opened.live
      entry.turn = { broker, turnId: turn.turnId }
      if (abort.signal.aborted) opened.live.interrupt()
      opened.live.input.open(opening)
      settled = yield* this.translated(entry, opened.live, opened.frames, turn.assistantMessageId, turn.todos, broker, abort.signal)
    } catch (error) {
      if (!aborted() || !(error instanceof AbortError)) throw error
    } finally {
      broker.signal.removeEventListener("abort", onAbort)
      entry.active = undefined
      if (active.live) await this.endTurn(entry, active.live, turn.turnId, settled)
    }
  }

  private async *translated(entry: ClaudeEntry, live: ClaudeLiveQuery, frames: AsyncIterable<ClaudeFrame>, assistantMessageId: string,
    todos: TurnInput["todos"], broker: TurnBroker, signal: AbortSignal): AsyncGenerator<RoutedEvent, boolean> {
    const { runtime, tasks } = claudeTranslator(assistantMessageId, todos, live.tasks)
    const mirroredUsage = new ClaudeMirroredUsage(runtime, { broker: entry.broker, assistantMessageId, directory: entry.input.directory })
    live.usage.target(mirroredUsage)
    try {
      let result: SDKMessage | undefined
      for await (const message of frames) {
        const observed = await observeClaudeSessionMessage(message, entry, entry.broker, signal)
        if (observed.kind === "active-goal") continue
        const incorporated = live.input.observe(observed.message)
        if (incorporated) {
          for (const messageId of incorporated) yield { event: { type: "input-incorporated", messageId } }
          continue
        }
        if (observed.message.type === "result") { result = observed.message; continue }
        for (const event of await translateClaude(observed.message, runtime, tasks, broker)) yield event
      }
      if (result) {
        mirroredUsage.release()
        for (const event of await translateClaude(result, runtime, tasks, broker)) yield event
      }
      if (!result && !signal.aborted) throw claudeStreamEndedWithoutResult()
      return true
    } finally { mirroredUsage.release() }
  }
}
