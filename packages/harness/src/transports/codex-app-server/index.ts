import { prefixedRandomId, settleAtRequestDeadline } from "@claxedo/helpers"
import { HARNESS_TABLE, type SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, BackgroundTaskRef, ConfigApplied, Deadline, DraftLaunch, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { ProcessLosses, selectedTurnAccount } from "../../contract"
import { draftProbeKey, DraftProbeCache } from "../../contract/probe-cache"
import { withTurnAccount } from "../../translate/turn-account"
import { codexProbeInputs } from "../../profiles/codex"
import { createCodexConfig } from "./config"
import { codexHealth } from "./health"
import { codexCapabilities } from "./capabilities"
import { codexTurnInput } from "./input"
import type { CodexTransportOptions, Entry } from "./entry"
import { CodexRequestRefusal, CodexDeadlineError } from "./errors"
import { createCodexGoals } from "./goals"
import { CodexLaunches } from "./launch"
import { readCodexModels, type CodexModel } from "./models"
import { answerCodexRequest, isCodexRequestMethod, requestingChild } from "./requests"
import { stopCodexChild } from "./native-children"
import { codexRetirementDeadline, type RpcMessage } from "./rpc"
import { CodexSessions } from "./sessions"
import { codexRename, codexSessionTitle } from "./titles"
import { activeTurnBroker, runCodexTurn } from "./turn"

export type { CodexTransportOptions, Entry } from "./entry"

export class CodexAppServerTransport implements HarnessTransport {
  readonly kind = "codex-app-server" as const
  private readonly probes = new DraftProbeCache<CodexModel[]>()
  private readonly losses = new ProcessLosses(() => this.services.healthChanged())
  private readonly launches: CodexLaunches
  private readonly sessions: CodexSessions

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {
    this.launches = new CodexLaunches(services, options)
    this.sessions = new CodexSessions(this.launches, services, this.losses, (entry, message, signal) => this.answer(entry, message, signal))
  }

  async capabilities(context: { sessionId?: string; directory: string }) {
    const entry = context.sessionId ? this.sessions.entries.get(context.sessionId)
      : [...this.sessions.entries.values()].find((item) => item.session.directory === context.directory)
    return codexCapabilities(entry ? await this.models(entry) : [])
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> { return (await this.sessions.open(input, broker)).session }
  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    return (await this.sessions.open(input, broker, input.binding.upstreamSessionId)).session
  }

  private async models(target: Entry): Promise<CodexModel[]> {
    const entry = await this.sessions.live(target.session)
    if (entry.models) return entry.models
    const reading = readCodexModels(entry.rpc)
    entry.models = reading
    try { return await reading }
    catch (error) {
      if (entry.models === reading) entry.models = undefined
      throw error
    }
  }

  readonly config = createCodexConfig({
    entry: (session) => this.sessions.entry(session), models: (entry) => this.models(entry),
    probe: (draft, mode) => this.probeDraftModels(draft, mode),
  })

  private probeDraftModels(draft: DraftLaunch, mode: "probe" | "peek"): Promise<CodexModel[]> {
    const key = draftProbeKey(draft)
    const inputs = { files: codexProbeInputs(draft.credentials, draft.directory, this.options.ownerHome) }
    if (mode === "peek") return this.probes.peek(key, inputs).then((models) => models ?? [])
    return this.probes.read(key, inputs, () => this.probeModels({ ...draft, sessionId: prefixedRandomId("probe", "-") }))
  }

  private async probeModels(input: StartInput): Promise<CodexModel[]> {
    const { rpc } = await this.launches.launch(input)
    try { return await readCodexModels(rpc) }
    finally { await this.launches.discard(rpc) }
  }

  private async answer(entry: Entry, message: RpcMessage, signal: AbortSignal): Promise<unknown> {
    if (!message.method) throw new CodexRequestRefusal(-32600, "Codex request has no method")
    const child = requestingChild(entry, message)
    await child?.flushed()
    const active = await activeTurnBroker(entry)
    if (!active && !child && isCodexRequestMethod(message.method)) throw new CodexRequestRefusal(-32000, "Codex request has no active turn")
    const broker = active ?? entry.broker
    return answerCodexRequest(message, { ask: (request) => broker.ask(child ? { ...request, child: { correlationKey: child.threadId } } : request, { signal }) },
      entry.session.binding.sessionId, { directory: entry.session.directory, permissionMode: entry.start.config.permissionMode })
  }

  readonly backgroundTasks = { stop: async (session: HarnessSession, task: BackgroundTaskRef) => stopCodexChild(this.sessions.entry(session), task) }

  readonly goals = createCodexGoals((session) => this.sessions.live(session))

  readonly health = codexHealth(this.losses, (sessionId) => this.sessions.connected(sessionId))

  readonly naming = {
    generateTitle: async (session: HarnessSession, request: SessionTitleRequest) =>
      codexSessionTitle(await this.sessions.live(session), request, this.services),
    rename: async (session: HarnessSession, name: string) => codexRename(await this.sessions.live(session), session.binding.upstreamSessionId, name),
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = await this.sessions.live(session)
    entry.usage.attach({ sessionId: session.binding.sessionId, directory: session.directory, assistantMessageId: turn.assistantMessageId })
    yield* withTurnAccount(runCodexTurn(entry, session, turn, broker, this.services, () => this.models(entry),
      () => this.cancel(session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId }, codexRetirementDeadline(this.services))),
    selectedTurnAccount("codex", entry.start.credentials, HARNESS_TABLE.codex.providerIds))
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.sessions.entry(session)
    const turn = entry.turn
    if (!turn && entry.providerTurn) return entry.terminals.stop(entry.providerTurn.id, deadline)
    if (entry.state !== "busy" || !turn) return { execution: "unknown" as const, cleanup: "unknown" as const }
    await settleAtRequestDeadline("Codex turn startup", { signal: deadline.signal, deadlineAt: deadline.at },
      turn.started, () => {}, () => new CodexDeadlineError("Codex turn startup exceeded the stop deadline"))
    if (!turn.id) return { execution: "unknown" as const, cleanup: "unknown" as const }
    return entry.terminals.stop(turn.id, deadline)
  }

  readonly steer = { steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
    const entry = this.sessions.entry(session)
    const turnId = entry.turn ? entry.turn.id : entry.providerTurn?.id
    if (!turnId) return { ok: false as const, status: "no_active_turn" as const, message: "No active Codex turn" }
    entry.steers.add(input.userMessageId)
    await entry.rpc.request("turn/steer", { threadId: session.binding.upstreamSessionId, expectedTurnId: turnId,
      clientUserMessageId: input.userMessageId, input: await codexTurnInput(input, session.directory) })
    return { ok: true as const }
  } }

  configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> { return this.sessions.configure(session, update) }

  close(session: HarnessSession): Promise<void> { return this.sessions.close(session) }

  dispose(): Promise<void> { return this.sessions.dispose() }
}
