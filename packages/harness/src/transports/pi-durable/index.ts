import type { AdapterCancelOutcome, SessionTitleRequest, SteerResult } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { attachedSessionEntry, sessionConnectionHealth, type AttachInput, type ConfigApplied, type Deadline, type HarnessServices,
  type HarnessSession, type HarnessTransport, type RoutedEvent, type SessionBroker, type StartInput, type TransportCapabilities,
  type TransportConfigUpdate, type TurnBroker, type TurnInput, type TurnRef } from "../../contract"
import { withTurnAccount } from "../../translate/turn-account"
import { createPiConfig, piModel, piModelRef, piThinkingLevel } from "./config"
import { piSession } from "./errors"
import type { PiPlacement } from "./placement"
import { PiRun } from "./run"
import { PiSession } from "./session"
import { piSessionTitle } from "./title"
import { piTurnContent } from "./turn"

export { piHarnessOptions, type PiPlacement, type PiSessionRuntime, type PiSubmitOptions, type PiTurnContext } from "./placement"

export class PiDurableTransport implements HarnessTransport {
  readonly kind = "pi-durable" as const
  private readonly entries = new Map<string, { session: HarnessSession; entry: PiSession }>()

  constructor(private readonly services: HarnessServices, private readonly placement: PiPlacement) {}

  async capabilities(): Promise<TransportCapabilities> {
    return {
      modelSelection: { status: "required", models: [] }, effortLevels: { status: "unresolved", models: [] },
      instructionChannel: "prompt-prefix", requests: { permissions: true, questions: true, elicitation: false },
      subagents: false, goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
      todos: false, history: "store", durableRuns: true,
    }
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.remember(await this.open(input, broker), broker)
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    const session = await this.open(input, broker)
    if (String(session.runtime.conversation.id) === input.binding.upstreamSessionId) return this.remember(session, broker)
    await session.close()
    throw piSession(`Pi reopened conversation ${session.runtime.conversation.id}, not ${input.binding.upstreamSessionId}`)
  }

  private async open(input: StartInput, broker: SessionBroker): Promise<PiSession> {
    const previous = this.entries.get(input.sessionId)
    this.entries.delete(input.sessionId)
    await previous?.entry.close()
    return PiSession.open({ start: input, broker, placement: this.placement, services: this.services })
  }

  private async remember(session: PiSession, broker: SessionBroker): Promise<HarnessSession> {
    try {
      const binding = await broker.rebind(String(session.runtime.conversation.id))
      const harnessSession = { binding, directory: session.start.directory, locality: session.start.locality }
      this.entries.set(session.sessionId, { session: harnessSession, entry: session })
      return harnessSession
    } catch (error) {
      await session.close()
      throw error
    }
  }

  private entry(session: HarnessSession): PiSession {
    return attachedSessionEntry(this.entries, session, () => piSession("Pi session is not attached")).entry
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    const content = piTurnContent(turn)
    if (this.placement.prepareTurn) await entry.configure(await this.placement.prepareTurn(entry.sessionId, broker.signal))
    const ref = piModelRef(turn.model ?? entry.start.config.model ?? entry.start.model)
    const thinkingLevel = piThinkingLevel(piModel(entry.credentials, ref), turn.effort)
    await entry.runtime.conversation.configure({ model: ref, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) }, BACKGROUND_CONTEXT)
    if (broker.signal.aborted) return
    const requestId = `turn:${turn.turnId}:${crypto.randomUUID()}`
    const run = new PiRun(entry.sessionId, broker, { requestId })
    const release = entry.stream.claim(run)
    const stop = () => { void entry.stop().then(undefined, (error: unknown) => run.fail(error)) }
    broker.signal.addEventListener("abort", stop, { once: true })
    try {
      await entry.runtime.submit(content, { requestId, whenBusy: "followUp" })
      yield* withTurnAccount(run.queue, entry.credentials.account(ref.provider))
    } finally {
      broker.signal.removeEventListener("abort", stop)
      release()
    }
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline): Promise<AdapterCancelOutcome> {
    const entry = this.entry(session)
    let timer: unknown
    const late = new Promise<"late">((resolve) => { timer = this.services.clock.setTimeout(() => resolve("late"), Math.max(0, deadline.at - this.services.clock.now())) })
    try {
      if (await Promise.race([entry.stop(deadline.signal).then(() => "stopped" as const), late]) === "stopped") return { execution: "terminal", cleanup: "unknown" }
      return { execution: "unknown", cleanup: "owned", error: { code: "cancellation_timeout", message: "Pi did not stop before the deadline" } }
    } catch (error) {
      return { execution: "unknown", cleanup: "owned", error: { code: "provider_unreachable", message: errorMessage(error) } }
    } finally { this.services.clock.clearTimeout(timer) }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    await this.entry(session).configure(update)
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    this.entries.delete(entry.sessionId)
    await entry.close()
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map(({ entry }) => entry.close()))
  }

  readonly steer = {
    steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput): Promise<SteerResult> => {
      const entry = this.entry(session)
      const run = entry.stream.active
      if (!run) return { ok: false, status: "no_active_turn", message: "No Pi turn is active" }
      const steer = run.steer(input.userMessageId)
      try { await entry.runtime.submit(piTurnContent(input), { requestId: steer.requestId, whenBusy: "steer" }) }
      catch (error) { steer.withdraw(); throw error }
      return { ok: true }
    },
  }

  readonly config = createPiConfig({ session: (session) => this.entry(session) })

  readonly naming = {
    generateTitle: async (session: HarnessSession, request: SessionTitleRequest) => {
      const entry = this.entry(session)
      const agent = await entry.runtime.conversation.agent(BACKGROUND_CONTEXT)
      const ref = request.model ? piModelRef(request.model) : agent.model ?? piModelRef(entry.start.config.model ?? entry.start.model)
      return piSessionTitle(entry.credentials.models, piModel(entry.credentials, ref), request)
    },
  }

  readonly health = {
    connection: (_directory: string, sessionId?: string) => sessionConnectionHealth(sessionId, (id) => this.entries.has(id), "disconnected"),
    runtime: () => ({ status: "ok" as const }),
  }
}
