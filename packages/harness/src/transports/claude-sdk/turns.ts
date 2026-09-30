import { AbortError, type EffortLevel, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { isHarnessEffortLevel, type SteerResult } from "@claxedo/agent-runtime-contract"
import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { Deadline, HarnessServices, HarnessSession, RoutedEvent, SessionBroker, StartInput, TurnBroker, TurnInput, TurnRef } from "../../contract"
import { TransportError } from "../../contract/errors"
import { claudePrompt } from "./attachments"
import { claudeStreamEndedWithoutResult } from "./errors"
import { claudeTranslator, translateClaude } from "./events"
import { ClaudeLiveQuery, type ClaudeClaim } from "./live-query"
import { ClaudeMirroredUsage } from "./mirrored-usage"
import { type ClaudeModelCatalog, requiredClaudeEffort } from "./models"
import { type ClaudeProcess, retireClaudeProcesses } from "./process"
import type { ClaudeLaunchTurn, ClaudeQueryLauncher } from "./query-options"
import { observeClaudeSessionMessage } from "./session-events"
import { settledBy } from "./turn-deadline"

type Running = { live?: ClaudeLiveQuery; done: Promise<void> }

type ClaudeActive = Running & { id: string; abort: AbortController; launched: boolean }

export type ClaudeEntry = {
  input: StartInput
  revision: number
  session: HarnessSession
  broker: SessionBroker
  processes: Set<ClaudeProcess>
  active?: ClaudeActive
  provider?: Running & { turnId: string; live: ClaudeLiveQuery }
  turn?: ClaudeLaunchTurn
  live?: ClaudeLiveQuery
  retiring?: { live: ClaudeLiveQuery; done: Promise<void> }
}

type Launch = { key: string; model: string; effort?: EffortLevel; turn: TurnInput }

type Scope = { assistantMessageId: string; todos: TurnInput["todos"]; broker: TurnBroker; signal: AbortSignal; final: boolean }

function claudeEffort(value: string | null | undefined): EffortLevel | undefined {
  if (!value) return undefined
  if (!isHarnessEffortLevel(value)) throw new TransportError("claude", "configuration", `Unsupported Claude effort ${value}`)
  return value
}

function settlement(): { done: Promise<void>; finish: () => void } {
  let finish!: () => void
  return { done: new Promise<void>((resolve) => { finish = resolve }), finish }
}

export class ClaudeTurns {
  constructor(private readonly launcher: () => ClaudeQueryLauncher, private readonly models: ClaudeModelCatalog,
    private readonly log: HarnessServices["log"]) {}

  async steer(entry: ClaudeEntry, ref: TurnRef, input: TurnInput): Promise<SteerResult> {
    const active = entry.active
    return active?.id === ref.turnId && active.live ? active.live.input.steer(await claudePrompt(input, entry.session.directory), input.userMessageId)
      : { ok: false as const, status: "no_active_turn" as const, message: "Claude turn is idle" }
  }

  async cancel(entry: ClaudeEntry, turn: TurnRef, deadline: Deadline): Promise<AdapterCancelOutcome> {
    const provider = entry.provider?.turnId === turn.turnId ? entry.provider : undefined
    const active = entry.active?.id === turn.turnId ? entry.active : undefined
    const running = provider ?? active
    if (!running) return { execution: "terminal", cleanup: "unknown" }
    if (active && !active.launched) {
      active.abort.abort()
      return { execution: "terminal", cleanup: "verified_clear" }
    }
    if (active) active.abort.abort()
    else if (running.live) this.interrupt(running.live)
    if (await settledBy(running.done, deadline)) return { execution: "terminal", cleanup: "unknown" }
    running.live?.terminate()
    return { execution: "unknown", cleanup: "unknown" }
  }

  async stop(entry: ClaudeEntry): Promise<void> {
    entry.active?.abort.abort()
    entry.live?.terminate()
    await retireClaudeProcesses(entry.processes)
  }

  async *run(entry: ClaudeEntry, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    if (entry.active || entry.provider) throw new TransportError("claude", "session", "Claude turn already active")
    const { done, finish } = settlement()
    const active: ClaudeActive = { id: turn.turnId, abort: new AbortController(), launched: false, done }
    entry.active = active
    active.abort.signal.addEventListener("abort", () => { if (active.live) this.interrupt(active.live) }, { once: true })
    const onAbort = () => active.abort.abort()
    if (broker.signal.aborted) onAbort()
    else broker.signal.addEventListener("abort", onAbort, { once: true })
    const scope: Scope = { assistantMessageId: turn.assistantMessageId, todos: turn.todos, broker, signal: active.abort.signal, final: true }
    let settled = false
    try {
      settled = yield* this.prompted(entry, active, turn, scope)
    } catch (error) {
      if (!active.abort.signal.aborted || !(error instanceof AbortError)) throw error
    } finally {
      broker.signal.removeEventListener("abort", onAbort)
      entry.active = undefined
      if (active.live) this.endTurn(entry, active.live, turn.turnId, settled)
      finish()
    }
  }

  private async *prompted(entry: ClaudeEntry, active: ClaudeActive, turn: TurnInput, scope: Scope): AsyncGenerator<RoutedEvent, boolean> {
    if (scope.signal.aborted) return false
    const opening = await claudePrompt(turn, entry.input.directory)
    const launch = await this.launchFor(entry, turn)
    const prior = entry.live
    if (prior && (!prior.reusable || prior.key !== launch.key)) yield* this.drain(entry, prior, active, scope, turn.turnId)
    if (scope.signal.aborted) return false
    entry.turn = { broker: scope.broker, turnId: turn.turnId }
    active.launched = true
    const opened = await this.open(entry, launch, opening)
    active.live = opened.live
    if (scope.signal.aborted) this.interrupt(opened.live)
    return yield* this.translated(entry, opened.live, opened.claim, scope)
  }

  private async *drain(entry: ClaudeEntry, prior: ClaudeLiveQuery, active: ClaudeActive, scope: Scope, turnId: string): AsyncGenerator<RoutedEvent> {
    await prior.stopBackground()
    const claim = prior.claim("exit")
    if (claim) {
      active.live = prior
      active.launched = true
      entry.turn = { broker: scope.broker, turnId }
      yield* this.translated(entry, prior, claim, { ...scope, final: false })
      prior.release()
      active.live = undefined
    }
    await this.retire(entry, prior)
  }

  private interrupt(live: ClaudeLiveQuery): void {
    void live.interrupt().then(undefined, (error: unknown) => {
      this.log.warn("Claude refused the interrupt; ending its process", { error: errorMessage(error) })
      live.terminate()
    })
  }

  private async launchFor(entry: ClaudeEntry, turn: TurnInput): Promise<Launch> {
    const model = turn.model?.modelID ?? "default"
    const effort = claudeEffort(requiredClaudeEffort(turn.effort ? await this.models.load(entry.input, entry.input.sessionId) : [], model, turn.effort))
    const key = JSON.stringify([entry.revision, entry.broker.config(), model, effort ?? null, turn.system ?? null, turn.prompt.agent ?? null])
    return { key, model, ...(effort ? { effort } : {}), turn }
  }

  private async open(entry: ClaudeEntry, launch: Launch, opening: SDKUserMessage): Promise<{ live: ClaudeLiveQuery; claim: ClaudeClaim }> {
    const current = entry.live
    if (current?.reusable && current.key === launch.key) {
      current.input.open(opening)
      return { live: current, claim: current.claim("prompt")! }
    }
    const live: ClaudeLiveQuery = new ClaudeLiveQuery(launch.key, () => this.admitOwnTurn(entry, live))
    entry.live = live
    live.input.open(opening)
    const claim = live.claim("prompt")!
    try {
      live.run(await this.launcher().launch({ session: entry.session, input: entry.input, broker: entry.broker, turn: () => entry.turn,
        prompt: live.input.stream, abort: live.abort, processes: entry.processes, usage: live.usage, model: launch.model, effort: launch.effort,
        system: launch.turn.system, agent: launch.turn.prompt.agent, partialMessages: true }))
    } catch (error) {
      live.fail(error)
      if (entry.live === live) entry.live = undefined
      throw error
    }
    return { live, claim }
  }

  private retire(entry: ClaudeEntry, live: ClaudeLiveQuery): Promise<void> {
    if (entry.retiring?.live === live) return entry.retiring.done
    const done = live.ended.then(async () => {
      if (entry.live === live) entry.live = undefined
      if (live.failure !== undefined) this.log.warn("Claude Code ended with an error after its last turn", { error: errorMessage(live.failure) })
      await retireClaudeProcesses(entry.processes)
    })
    entry.retiring = { live, done }
    void done.then(undefined, (error: unknown) => this.log.error("Claude Code process retirement failed", { error: errorMessage(error) }))
    return done
  }

  private admitOwnTurn(entry: ClaudeEntry, live: ClaudeLiveQuery): void {
    void entry.broker.admitProviderTurn({ reason: "provider" }, (broker, turn) => this.ownTurn(entry, live, broker, turn)).then((admission) => {
      if (!admission.admitted && admission.reason === "closed") live.close()
    }, (error: unknown) => entry.broker.reportFailure(error))
  }

  private async *ownTurn(entry: ClaudeEntry, live: ClaudeLiveQuery, broker: TurnBroker, turn: TurnRef): AsyncIterable<RoutedEvent> {
    const claim = live.claim("result")
    if (!claim) return
    const { done, finish } = settlement()
    entry.provider = { turnId: turn.turnId, live, done }
    entry.turn = { broker, turnId: turn.turnId }
    const onAbort = () => this.interrupt(live)
    if (broker.signal.aborted) onAbort()
    else broker.signal.addEventListener("abort", onAbort, { once: true })
    let settled = false
    try {
      settled = yield* this.translated(entry, live, claim, { assistantMessageId: turn.assistantMessageId, todos: [], broker, signal: broker.signal, final: true })
    } finally {
      broker.signal.removeEventListener("abort", onAbort)
      if (entry.provider?.turnId === turn.turnId) entry.provider = undefined
      this.endTurn(entry, live, turn.turnId, settled)
      finish()
    }
  }

  private endTurn(entry: ClaudeEntry, live: ClaudeLiveQuery, turnId: string, settled: boolean): void {
    if (entry.turn?.turnId === turnId) entry.turn = undefined
    live.release()
    if (!settled) live.terminate()
    live.input.settle(settled && !live.reusable ? "ended" : "failed")
    if (!live.reusable) void this.retire(entry, live)
  }

  private async *translated(entry: ClaudeEntry, live: ClaudeLiveQuery, claim: ClaudeClaim, scope: Scope): AsyncGenerator<RoutedEvent, boolean> {
    if (claim.dropped) yield claim.dropped
    const { runtime, tasks } = claudeTranslator(scope.assistantMessageId, scope.todos, live.tasks)
    const mirroredUsage = new ClaudeMirroredUsage(runtime, { broker: entry.broker, assistantMessageId: scope.assistantMessageId, directory: entry.input.directory })
    live.usage.target(mirroredUsage)
    try {
      let result: SDKMessage | undefined
      for await (const message of claim.frames) {
        const observed = await observeClaudeSessionMessage(message, entry, entry.broker, scope.signal)
        if (observed.kind === "active-goal") continue
        const incorporated = live.input.observe(observed.message)
        if (incorporated) {
          for (const messageId of incorporated) yield { event: { type: "input-incorporated", messageId } }
          continue
        }
        if (observed.message.type === "result") { result = observed.message; continue }
        for (const event of await translateClaude(observed.message, runtime, tasks, scope.broker)) yield event
      }
      if (!scope.final) return true
      if (result) {
        mirroredUsage.release()
        for (const event of await translateClaude(result, runtime, tasks, scope.broker)) yield event
      }
      if (!result && !scope.signal.aborted) throw claudeStreamEndedWithoutResult()
      return true
    } finally { mirroredUsage.release() }
  }
}
