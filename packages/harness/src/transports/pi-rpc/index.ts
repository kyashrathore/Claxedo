import { errorMessage, singleFlightUntil } from "@claxedo/helpers"
import type { AdapterCancelOutcome, PromptModel, SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, ConfigApplied, ConfigTarget, Deadline, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, mergeStartInput, ProcessLosses, sessionConnectionHealth } from "../../contract"
import { selectPiProfile, type PiProfile } from "../../profiles/pi"
import { TransportError } from "../../contract/errors"
import { piEvents } from "./events"
import { AsyncPushQueue } from "@claxedo/helpers"
import { PiRpc, type PiMessage } from "./rpc"
import { answerPiDialog } from "./ui"
import { piCommands } from "./commands"
import { PiDraftProbes } from "./probes"
import { UnsettledPiLaunches } from "./retirements"
import { inlineDataUrl, flattenTurnPrompt } from "../../translate/prompt"
import { createPiConfig, piModelSelection, piThinkingLevel, piTurnAccount } from "./config"
import { withTurnAccount } from "../../translate/turn-account"
import { piSessionTitle } from "./title"
import { launchPi, piDeadline, piUpstreamOf, resumePi, retiringOnFailure, type PiLaunchHost, type PiRpcOptions } from "./launch"

type Entry = {
  session: HarnessSession
  start: StartInput
  profile: PiProfile
  broker: SessionBroker
  rpc: PiRpc
  busy: boolean
  prompted: boolean
  stopUnprompted?: () => void
  settled: boolean
}

export type { PiRpcOptions } from "./launch"

function piRpcPromptBody(turn: TurnInput): { message: string; images?: { type: "image"; mimeType: string; data: string }[] } {
  const images = turn.prompt.parts.flatMap((part) => {
    if (part.type !== "file") return []
    const image = inlineDataUrl(part.url, { imageOnly: true, strictBase64: false })
    if (!image) throw new TransportError("pi", "configuration", "Pi attachments require an inline base64 image; refer to workspace files by path")
    return [{ type: "image" as const, ...image }]
  })
  return { message: flattenTurnPrompt(turn, { separator: "\n", system: "prefix" }), ...(images.length ? { images } : {}) }
}

export class PiRpcTransport implements HarnessTransport {
  readonly kind = "pi-rpc" as const
  private readonly entries = new Map<string, Entry>()
  private readonly stops = new WeakMap<Entry, (deadline: Deadline) => Promise<AdapterCancelOutcome>>()
  private readonly disposeAbort = new AbortController()
  private readonly host: PiLaunchHost
  private readonly probes: PiDraftProbes
  private readonly losses: ProcessLosses
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: PiRpcOptions) {
    this.host = { services, options, signal: this.disposeAbort.signal, disposed: () => this.disposed,
      unsettled: new UnsettledPiLaunches(services.clock, services.log) }
    this.probes = new PiDraftProbes(this.host)
    this.losses = new ProcessLosses(() => services.healthChanged())
  }

  async capabilities(): Promise<TransportCapabilities> {
    return {
      modelSelection: { status: "required", models: [] }, effortLevels: { status: "unresolved", models: [] },
      instructionChannel: "prompt-prefix" as const, configOwner: "runtime" as const,
      requests: { permissions: false, questions: true, elicitation: false },
      subagents: false, goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
      todos: false, history: "store" as const,
      titles: "side-request" as const,
      pluginIntake: { mcp: "none" as const, skills: "skill-dirs" as const },
      mcpTransports: { stdio: false, http: false, sse: false },
      timing: { model: "immediate" as const, effort: "immediate" as const, permissionMode: "immediate" as const, credentials: "after-active-turns" as const },
    }
  }

  private async remember(input: StartInput, profile: PiProfile, rpc: PiRpc, broker: SessionBroker, upstreamSessionId: string): Promise<HarnessSession> {
    const binding = await retiringOnFailure(this.host, rpc, () => broker.rebind(upstreamSessionId))
    const session: HarnessSession = { binding, directory: input.directory, locality: input.locality }
    this.entries.set(input.sessionId, { session, start: input, profile, broker, rpc, busy: false, prompted: false, settled: true })
    this.track(input.sessionId, rpc)
    return session
  }

  private track(sessionId: string, rpc: PiRpc): void {
    this.losses.recovered(sessionId)
    rpc.onLoss((error) => { if (this.entries.get(sessionId)?.rpc === rpc) this.losses.record(sessionId, error.message) })
  }

  private async retireSession(entry: Entry): Promise<void> {
    try { await entry.rpc.retire(piDeadline(this.services.clock)) }
    catch (error) { this.services.healthChanged(); throw error }
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    const profile = selectPiProfile(input.credentials, input.directory, input.sessionId, this.options)
    const rpc = await launchPi(this.host, input, profile, broker, { role: "harness" })
    return this.remember(input, profile, rpc, broker, await piUpstreamOf(this.host, rpc))
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    const profile = selectPiProfile(input.credentials, input.directory, input.sessionId, this.options)
    const rpc = await resumePi(this.host, input, profile, broker, input.binding.upstreamSessionId)
    return this.remember(input, profile, rpc, broker, input.binding.upstreamSessionId)
  }

  private entry(session: HarnessSession): Entry {
    return attachedSessionEntry(this.entries, session, () => new TransportError("pi", "session", "Pi session is not attached"))
  }

  private receiveTurn(entry: Entry, broker: TurnBroker, queue: AsyncPushQueue<RoutedEvent>, pending: Set<Promise<void>>,
    dialogAbort: AbortController): () => void {
    const translate = piEvents(entry.session.binding.sessionId)
    return entry.rpc.onEvent((message: PiMessage) => {
      try {
        for (const event of translate(message)) queue.push(event)
        if (message.type === "extension_ui_request") {
          const task = answerPiDialog(message, entry.rpc, broker, entry.session.binding.sessionId, this.services.clock.now(), dialogAbort.signal)
          pending.add(task)
          void task.then(() => pending.delete(task), (error: unknown) => queue.fail(error))
        }
        if (message.type === "agent_settled") { entry.settled = true; dialogAbort.abort(); queue.end() }
      } catch (error) { queue.fail(error) }
    })
  }

  private async applyTurnConfig(entry: Entry, model: PromptModel | undefined, effort: string | null | undefined): Promise<void> {
    if (model) await entry.rpc.request("set_model", piModelSelection(model))
    if (!effort) return
    await entry.rpc.request("set_thinking_level", { level: effort })
    const kept = await piThinkingLevel(entry.rpc)
    if (kept !== effort) {
      throw new TransportError("pi", "configuration",
        `Pi does not run ${model?.modelID ?? "its current model"} at thinking level ${effort}${kept ? `; it kept ${kept}` : ""}`)
    }
  }

  private beginTurn(entry: Entry, turn: TurnInput, broker: TurnBroker, queue: AsyncPushQueue<RoutedEvent>) {
    let stopped = false
    entry.stopUnprompted = () => { stopped = true; queue.end() }
    const onAbort = () => {
      if (!entry.prompted) { entry.stopUnprompted?.(); return }
      void this.cancel(entry.session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId }, piDeadline(this.services.clock)).then(
        (result) => { if (result.error) queue.fail(new TransportError("pi", "process", result.error.message)) },
        (error: unknown) => queue.fail(error),
      )
    }
    broker.signal.addEventListener("abort", onAbort, { once: true })
    return {
      prompt: async (body: ReturnType<typeof piRpcPromptBody>) => {
        await this.applyTurnConfig(entry, turn.model, turn.effort)
        if (stopped || broker.signal.aborted) return queue.end()
        entry.prompted = true
        await entry.rpc.request("prompt", body)
      },
      release: () => {
        broker.signal.removeEventListener("abort", onAbort)
        entry.stopUnprompted = undefined
      },
    }
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.busy) throw new TransportError("pi", "session", "Pi turn already active")
    const body = piRpcPromptBody(turn)
    const account = piTurnAccount(entry.start, turn.model)
    entry.busy = true
    entry.prompted = false
    entry.settled = false
    const queue = new AsyncPushQueue<RoutedEvent>()
    const pending = new Set<Promise<void>>()
    const dialogAbort = new AbortController()
    const remove = this.receiveTurn(entry, broker, queue, pending, dialogAbort)
    const removeFailure = entry.rpc.onFailure((error) => queue.fail(error))
    const started = this.beginTurn(entry, turn, broker, queue)
    try {
      await started.prompt(body)
      yield* withTurnAccount(queue, account)
      await Promise.all(pending)
    } catch (error) {
      await entry.rpc.retire(piDeadline(this.services.clock))
      this.entries.delete(session.binding.sessionId)
      throw error
    } finally {
      dialogAbort.abort()
      remove()
      removeFailure()
      started.release()
      entry.busy = false
    }
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline): Promise<AdapterCancelOutcome> {
    const entry = this.entry(session)
    if (!entry.busy || !entry.prompted) {
      entry.stopUnprompted?.()
      return { execution: "terminal", cleanup: "unknown" }
    }
    const stop = this.stops.get(entry) ?? singleFlightUntil((stopBy: Deadline) => this.stopPrompted(entry, stopBy), () => false)
    this.stops.set(entry, stop)
    return stop(deadline)
  }

  private async stopPrompted(entry: Entry, deadline: Deadline): Promise<AdapterCancelOutcome> {
    try {
      const results = await Promise.allSettled([
        entry.rpc.request("clear_queue", {}, deadline),
        entry.rpc.request("abort", {}, deadline),
      ])
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
      return { execution: entry.settled ? "terminal" as const : "unknown" as const, cleanup: "unknown" as const }
    } catch (error) {
      return { execution: "unknown" as const, cleanup: "owned" as const,
        error: { code: error instanceof TransportError && error.code === "timeout" ? "cancellation_timeout" as const : "provider_unreachable" as const,
          message: errorMessage(error) } }
    }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (!update.credentials && !update.projection) return { state: "applied" }
    if (entry.busy) return { state: "refused", reason: "Cannot reconfigure Pi during an active turn" }
    const start = mergeStartInput(entry.start, update)
    const profile = selectPiProfile(start.credentials, start.directory, start.sessionId, this.options, entry.profile.kind)
    await this.retireSession(entry)
    this.entries.delete(session.binding.sessionId)
    entry.rpc = await resumePi(this.host, start, profile, entry.broker, entry.session.binding.upstreamSessionId)
    entry.profile = profile
    entry.start = start
    this.entries.set(session.binding.sessionId, entry)
    this.track(session.binding.sessionId, entry.rpc)
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    await this.retireSession(entry)
    this.entries.delete(session.binding.sessionId)
    this.losses.recovered(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposeAbort.abort()
    await Promise.all([...this.entries.values()].map((entry) => entry.rpc.retire(piDeadline(this.services.clock))))
    await this.host.unsettled.sweep()
    for (const sessionId of this.entries.keys()) this.losses.recovered(sessionId)
    this.entries.clear()
  }

  readonly steer = {
    steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
      const entry = this.entry(session)
      if (!entry.busy) return { ok: false as const, status: "no_active_turn" as const, message: "No Pi turn is active" }
      await entry.rpc.request("steer", piRpcPromptBody(input))
      return { ok: true as const }
    },
  }

  readonly commands = {
    list: async (target: ConfigTarget) => "session" in target
      ? piCommands(this.entry(target.session).rpc) : this.probes.commands(target.draft),
  }

  readonly config = createPiConfig({ entry: (session) => this.entry(session), catalog: (draft, model, mode) => this.probes.catalog(draft, model, mode) })

  readonly naming = {
    generateTitle: async (session: HarnessSession, request: SessionTitleRequest) => {
      const entry = this.entry(session)
      if (entry.busy) return null
      return piSessionTitle(entry.rpc, this.options.stateRoot, request)
    },
    rename: async (session: HarnessSession, title: string) => {
      await this.entry(session).rpc.request("set_session_name", { name: title })
    },
  }

  readonly health = {
    connection: (_directory: string, sessionId?: string) => sessionConnectionHealth(sessionId, (id) => this.entries.has(id), "disconnected"),
    runtime: (_directory: string, sessionId?: string) => {
      const lost = this.losses.health(sessionId)
      if (lost) return lost
      const entry = sessionId ? this.entries.get(sessionId) : [...this.entries.values()][0]
      return { status: !entry || entry.rpc.alive ? "ok" as const : "degraded" as const }
    },
  }
}
