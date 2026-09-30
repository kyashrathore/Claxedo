import { randomUUID } from "node:crypto"
import { AbortError, type EffortLevel, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { isHarnessEffortLevel, type PromptModel, type SteerResult } from "@claxedo/agent-runtime-contract"
import type { AdapterCancelOutcome } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type { BackgroundTaskRef, BackgroundTaskStopResult, Deadline, HarnessServices, HarnessSession, HarnessVersionGate, RoutedEvent, SessionBroker,
  StartInput, TurnBroker, TurnInput, TurnRef } from "../../contract"
import { TransportError } from "../../contract/errors"
import { claudePrompt } from "./attachments"
import { ClaudeLiveQuery, type ClaudeClaim } from "./live-query"
import { type ClaudeModelCatalog, requiredClaudeEffort } from "./models"
import { retireClaudeProcesses } from "./process"
import type { ClaudeLaunchTurn, ClaudeQueryLauncher } from "./query-options"
import { commandResult, translatedClaim, type ClaudeScope } from "./claim-frames"
import { claudeBackgroundWork, claudeChildDelivery } from "./between-turns"
import { settledBy } from "./turn-deadline"

type Running = { live?: ClaudeLiveQuery; done: Promise<void> }

type ClaudeActive = Running & { id: string; abort: AbortController; launched: boolean }

export type ClaudeEntry = {
  input: StartInput
  revision: number
  session: HarnessSession
  broker: SessionBroker
  active?: ClaudeActive
  provider?: Running & { turnId: string; live: ClaudeLiveQuery }
  turn?: ClaudeLaunchTurn
  live?: ClaudeLiveQuery
  retiring?: { live: ClaudeLiveQuery; done: Promise<void> }
}

export type ClaudeChoice = { model?: PromptModel; effort?: string | null; system?: string; agent?: string }

type Launch = { key: string; model: string; effort?: EffortLevel; system?: string; agent?: string }


function claudeEffort(value: string | null | undefined): EffortLevel | undefined {
  if (!value) return undefined
  if (!isHarnessEffortLevel(value)) throw new TransportError("claude", "configuration", `Unsupported Claude effort ${value}`)
  return value
}

export function configuredChoice(entry: Pick<ClaudeEntry, "broker">): ClaudeChoice {
  const { model, variant, instructions, agent } = entry.broker.config()
  return { ...(model ? { model } : {}), ...(variant ? { effort: variant } : {}), ...(instructions ? { system: instructions } : {}), ...(agent ? { agent } : {}) }
}

function settlement(): { done: Promise<void>; finish: () => void } {
  let finish!: () => void
  return { done: new Promise<void>((resolve) => { finish = resolve }), finish }
}

export class ClaudeTurns {
  constructor(private readonly launcher: () => ClaudeQueryLauncher, private readonly models: ClaudeModelCatalog,
    private readonly log: HarnessServices["log"], private readonly versions: HarnessVersionGate) {}

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

  async stopBackgroundTask(entry: ClaudeEntry, task: BackgroundTaskRef): Promise<BackgroundTaskStopResult> {
    if (await entry.live?.stopTask(task.toolCallId)) return { ok: true }
    return { ok: false, status: "not_found", message: "No running Claude background task was started by that call" }
  }

  async stop(entry: ClaudeEntry): Promise<void> {
    entry.active?.abort.abort()
    const live = entry.live
    live?.terminate()
    await Promise.all([live ? retireClaudeProcesses(live.processes) : undefined, entry.retiring?.done])
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
    const scope: ClaudeScope = { assistantMessageId: turn.assistantMessageId, todos: turn.todos, broker, signal: active.abort.signal, final: true, versions: this.versions }
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

  private async *prompted(entry: ClaudeEntry, active: ClaudeActive, turn: TurnInput, scope: ClaudeScope): AsyncGenerator<RoutedEvent, boolean> {
    if (scope.signal.aborted) return false
    const opening = await claudePrompt(turn, entry.input.directory)
    const launch = await this.launchFor(entry, { model: turn.model, effort: turn.effort, system: turn.system, agent: turn.prompt.agent })
    const prior = entry.live
    if (prior && (!prior.reusable || prior.key !== launch.key)) yield* this.drain(entry, prior, active, scope, turn.turnId)
    if (scope.signal.aborted) return false
    entry.turn = { broker: scope.broker, turnId: turn.turnId }
    active.launched = true
    const opened = await this.open(entry, launch, opening)
    active.live = opened.live
    if (scope.signal.aborted) this.interrupt(opened.live)
    return yield* translatedClaim(entry, opened.live, opened.claim, scope)
  }

  async command(entry: ClaudeEntry, text: string, limitMs: number): Promise<SDKMessage | undefined> {
    if (entry.active || entry.provider) throw new TransportError("claude", "session", "Claude turn already active")
    const { done, finish } = settlement()
    const active: ClaudeActive = { id: `command:${randomUUID()}`, abort: new AbortController(), launched: true, done }
    entry.active = active
    try {
      const prior = entry.live
      if (prior && !prior.reusable) await this.retire(entry, prior)
      const opening: SDKUserMessage = { type: "user", session_id: "", message: { role: "user", content: text }, parent_tool_use_id: null }
      const opened = await this.open(entry, await this.launchFor(entry, configuredChoice(entry)), opening, () => true)
      active.live = opened.live
      const limit = setTimeout(() => opened.live.terminate(), limitMs)
      try { return await commandResult(entry, opened.claim, active.abort.signal, this.versions) } finally { clearTimeout(limit) }
    } finally {
      entry.active = undefined
      if (active.live) this.endTurn(entry, active.live, active.id, true)
      finish()
    }
  }

  private async *drain(entry: ClaudeEntry, prior: ClaudeLiveQuery, active: ClaudeActive, scope: ClaudeScope, turnId: string): AsyncGenerator<RoutedEvent> {
    await prior.stopBackground()
    const claim = prior.claim("exit")
    if (claim) {
      active.live = prior
      active.launched = true
      entry.turn = { broker: scope.broker, turnId }
      yield* translatedClaim(entry, prior, claim, { ...scope, final: false })
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

  private async launchFor(entry: ClaudeEntry, choice: ClaudeChoice): Promise<Launch> {
    const model = choice.model?.modelID ?? "default"
    const effort = claudeEffort(requiredClaudeEffort(choice.effort ? await this.models.load(entry.input, entry.input.sessionId) : [], model, choice.effort))
    const key = JSON.stringify([entry.revision, entry.broker.config(), model, effort ?? null, choice.system ?? null, choice.agent ?? null])
    return { key, model, ...(effort ? { effort } : {}), ...(choice.system ? { system: choice.system } : {}), ...(choice.agent ? { agent: choice.agent } : {}) }
  }

  private async open(entry: ClaudeEntry, launch: Launch, opening: SDKUserMessage,
    reuse = (live: ClaudeLiveQuery) => live.key === launch.key): Promise<{ live: ClaudeLiveQuery; claim: ClaudeClaim }> {
    const current = entry.live
    if (current?.reusable && reuse(current)) {
      current.input.open(opening)
      return { live: current, claim: current.claim("prompt")! }
    }
    const live: ClaudeLiveQuery = new ClaudeLiveQuery(launch.key, { unclaimed: (notice) => this.admitOwnTurn(entry, live, notice),
      child: claudeChildDelivery(entry, () => live), background: claudeBackgroundWork(entry) })
    entry.live = live
    live.input.open(opening)
    const claim = live.claim("prompt")!
    try {
      live.run(await this.launcher().launch({ session: entry.session, input: entry.input, broker: entry.broker, turn: () => entry.turn,
        prompt: live.input.stream, abort: live.abort, processes: live.processes, usage: live.usage, subagentCall: (agentId) => live.spawnCall(agentId), model: launch.model, effort: launch.effort,
        system: launch.system, agent: launch.agent }))
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
      await retireClaudeProcesses(live.processes)
    })
    entry.retiring = { live, done }
    void done.then(undefined, (error: unknown) => this.log.error("Claude Code process retirement failed", { error: errorMessage(error) }))
    return done
  }

  private admitOwnTurn(entry: ClaudeEntry, live: ClaudeLiveQuery, notice: string | undefined): void {
    void entry.broker.admitProviderTurn({ reason: "provider", ...(notice ? { detail: notice } : {}) }, (broker, turn) => this.ownTurn(entry, live, broker, turn)).then((admission) => {
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
      settled = yield* translatedClaim(entry, live, claim, { assistantMessageId: turn.assistantMessageId, todos: [], broker, signal: broker.signal, final: true, versions: this.versions })
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
}
