import { prefixedRandomId, settleAtRequestDeadline } from "@claxedo/helpers"
import { HARNESS_TABLE, type RuntimeGoalSnapshot, type SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type {
  AttachInput, ConfigApplied, Deadline, DraftLaunch, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, draftProbeKey, DraftProbeCache, mergeStartInput, ProcessLosses, selectedTurnAccount } from "../../contract"
import { withTurnAccount } from "../../translate/turn-account"
import { spawnCodexProfile } from "./launch"
import { codexProbeInputs } from "../../profiles/codex"
import { projectCodexThreadConfig } from "./configuration"
import { createCodexConfig } from "./config"
import { codexHealth } from "./health"
import { codexCapabilities } from "./capabilities"
import { codexThreadResumeParams, codexThreadStartParams, codexTurnInput } from "./input"
import { codexPermissionSettings } from "./modes"
import type { CodexEvents } from "./events"
import { CodexRequestRefusal, CodexTransportError, CodexDeadlineError } from "./errors"
import { createCodexGoals } from "./goals"
import { readCodexModels, type CodexModel } from "./models"
import type { CodexProviderTurn } from "./provider-turn"
import { codexNotificationOutsideTurn } from "./notifications"
import { answerCodexRequest, isCodexRequestMethod } from "./requests"
import { CodexRpc, codexRetirementDeadline, type RpcMessage } from "./rpc"
import { answerCodexToolCall, type CodexTurnSettings } from "./subagents"
import { CodexTerminals } from "./terminals"
import { codexRename, codexSessionTitle } from "./titles"
import { runCodexTurn } from "./turn"
import { CodexUsageLedger } from "./usage"

export type Entry = {
  state: "ready" | "busy" | "retiring"
  start: StartInput
  session: HarnessSession
  broker: SessionBroker
  rpc: CodexRpc
  home: string
  brokered: boolean
  terminals: CodexTerminals
  children: Map<string, CodexEvents>
  sideThreads: Set<string>
  usage: CodexUsageLedger
  goal: RuntimeGoalSnapshot | null
  models?: Promise<CodexModel[]>
  providerTurn?: CodexProviderTurn
  turn?: { broker: TurnBroker; id?: string; started: Promise<void>; settings: CodexTurnSettings }
}

export type CodexTransportOptions = { binary: string; homeRoot: string; ownerHome?: string; env?: NodeJS.ProcessEnv }

export class CodexAppServerTransport implements HarnessTransport {
  readonly kind = "codex-app-server" as const
  private readonly entries = new Map<string, Entry>()
  private readonly starting = new Set<CodexRpc>()
  private readonly probes: DraftProbeCache<CodexModel[]>
  private readonly disposeAbort = new AbortController()
  private readonly losses = new ProcessLosses(() => this.services.healthChanged())
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {
    this.probes = new DraftProbeCache()
  }

  async capabilities(context: { sessionId?: string; directory: string }) {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : [...this.entries.values()].find((item) => item.session.directory === context.directory)
    const models = entry ? await this.models(entry) : []
    return codexCapabilities(models)
  }

  private async launch(input: StartInput): Promise<{ rpc: CodexRpc; home: string; brokered: boolean }> {
    if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed")
    const { rpc, profile } = await spawnCodexProfile(input, this.options, this.services, this.disposeAbort.signal)
    this.starting.add(rpc)
    try {
      if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed during startup")
      await rpc.request("initialize", { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } })
      if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed during initialize")
      rpc.notify("initialized")
      return { rpc, ...profile }
    } catch (error) {
      await rpc.retire(codexRetirementDeadline(this.services))
      this.starting.delete(rpc)
      throw error
    }
  }

  private async open(input: StartInput, broker: SessionBroker, resumed?: string): Promise<HarnessSession> {
    const { rpc, home, brokered } = await this.launch(input)
    try {
      const config = projectCodexThreadConfig(input, this.services)
      if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed during startup")
      const mode = codexPermissionSettings(input.config.permissionMode)
      const result = asRecordOrEmpty(await rpc.request(resumed ? "thread/resume" : "thread/start",
        resumed ? codexThreadResumeParams(resumed, input, config, mode) : codexThreadStartParams(input, config, mode)))
      const threadId = asString(asRecordOrEmpty(result.thread).id) ?? ""
      if (!threadId || (resumed && threadId !== resumed)) throw new CodexTransportError("session", "Codex returned a different or missing thread")
      let entry: Entry | undefined
      let retiring = false
      const early: RpcMessage[] = []
      rpc.onRequest((message) => entry ? this.answer(entry, message)
        : Promise.reject(new CodexRequestRefusal(-32000, "Codex session is not bound yet")))
      rpc.onMessage((message) => { if (entry) codexNotificationOutsideTurn(entry, message); else early.push(message) })
      rpc.onFailure((error) => {
        retiring = true
        if (!entry) return
        if (entry.state !== "retiring") this.losses.record(input.sessionId, error.message)
        entry.state = "retiring"
        entry.providerTurn?.queue.fail(error)
      })
      const binding = await broker.rebind(threadId)
      if (retiring) throw new CodexTransportError("process", "Codex process retired during rebind")
      const session: HarnessSession = { directory: input.directory, locality: input.locality, binding }
      entry = { state: "ready", start: input, session, broker, rpc, home, brokered,
        terminals: new CodexTerminals(rpc, threadId), children: new Map(), sideThreads: new Set(), usage: new CodexUsageLedger(), goal: null }
      this.entries.set(input.sessionId, entry)
      this.losses.recovered(input.sessionId)
      this.starting.delete(rpc)
      for (const message of early) codexNotificationOutsideTurn(entry, message)
      return session
    } catch (error) {
      this.starting.delete(rpc)
      await rpc.retire(codexRetirementDeadline(this.services))
      throw error
    }
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> { return this.open(input, broker) }
  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.open(input, broker, input.binding.upstreamSessionId)
  }

  private entry(session: HarnessSession): Entry {
    return attachedSessionEntry(this.entries, session, () => new CodexTransportError("session", "Codex session is not attached"),
      (entry) => entry.state !== "retiring")
  }

  private models(entry: Entry): Promise<CodexModel[]> {
    entry.models ??= readCodexModels(entry.rpc)
    return entry.models
  }

  readonly config = createCodexConfig({
    entry: (session) => this.entry(session), models: (entry) => this.models(entry),
    probe: (draft, mode) => this.probeDraftModels(draft, mode),
  })

  private probeDraftModels(draft: DraftLaunch, mode: "probe" | "peek"): Promise<CodexModel[]> {
    const key = draftProbeKey(draft)
    const inputs = { files: codexProbeInputs(draft.credentials, draft.directory, this.options.ownerHome) }
    if (mode === "peek") return this.probes.peek(key, inputs).then((models) => models ?? [])
    return this.probes.read(key, inputs, () => this.probeModels({ ...draft, sessionId: prefixedRandomId("probe", "-") }))
  }

  private async probeModels(input: StartInput): Promise<CodexModel[]> {
    const { rpc } = await this.launch(input)
    try { return await readCodexModels(rpc) }
    finally {
      this.starting.delete(rpc)
      await rpc.retire(codexRetirementDeadline(this.services))
    }
  }

  private async answer(entry: Entry, message: RpcMessage): Promise<unknown> {
    if (!message.method) throw new CodexRequestRefusal(-32600, "Codex request has no method")
    if (message.method === "item/tool/call") {
      const broker = entry.turn?.broker ?? entry.providerTurn?.turnBroker
      return answerCodexToolCall(broker && { rpc: entry.rpc, directory: entry.session.directory, threadId: entry.session.binding.upstreamSessionId,
        brokered: entry.brokered, permissionMode: entry.start.config.permissionMode, settings: entry.turn?.settings ?? {}, children: entry.children }, broker, message)
    }
    if (!entry.turn && !entry.providerTurn && isCodexRequestMethod(message.method)) throw new CodexRequestRefusal(-32000, "Codex request has no active turn")
    return answerCodexRequest(message, entry.turn?.broker ?? entry.broker, entry.session.binding.sessionId,
      { directory: entry.session.directory, permissionMode: entry.start.config.permissionMode })
  }

  readonly goals = createCodexGoals((session) => this.entry(session))

  readonly health = codexHealth(this.losses, (sessionId) => this.entries.has(sessionId))

  readonly naming = {
    generateTitle: (session: HarnessSession, request: SessionTitleRequest) => codexSessionTitle(this.entry(session), request, this.services),
    rename: (session: HarnessSession, name: string) => codexRename(this.entry(session), session.binding.upstreamSessionId, name),
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    entry.usage.attach({ sessionId: session.binding.sessionId, directory: session.directory, assistantMessageId: turn.assistantMessageId })
    yield* withTurnAccount(runCodexTurn(entry, session, turn, broker, this.services, () => this.models(entry),
      () => this.cancel(session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId }, codexRetirementDeadline(this.services))),
    selectedTurnAccount("codex", entry.start.credentials, HARNESS_TABLE.codex.providerIds))
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    const turn = entry.turn
    if (entry.state !== "busy" || !turn) return { execution: "unknown" as const, cleanup: "unknown" as const }
    await settleAtRequestDeadline("Codex turn startup", { signal: deadline.signal, deadlineAt: deadline.at },
      turn.started, () => {}, () => new CodexDeadlineError("Codex turn startup exceeded the stop deadline"))
    if (!turn.id) return { execution: "unknown" as const, cleanup: "unknown" as const }
    return entry.terminals.stop(turn.id, deadline)
  }

  readonly steer = { steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
    const entry = this.entry(session)
    if (!entry.turn?.id) return { ok: false as const, status: "no_active_turn" as const, message: "No active Codex turn" }
    await entry.rpc.request("turn/steer", { threadId: session.binding.upstreamSessionId, expectedTurnId: entry.turn.id, input: await codexTurnInput(input, session.directory) })
    return { ok: true as const }
  } }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (!update.credentials && !update.projection) return { state: "applied" }
    if (entry.state === "busy" || entry.providerTurn) return { state: "refused", reason: "Codex turn is active" }
    const start = mergeStartInput(entry.start, update)
    if (JSON.stringify(start.credentials) === JSON.stringify(entry.start.credentials)
      && JSON.stringify(start.projection) === JSON.stringify(entry.start.projection)) return { state: "applied" }
    const threadId = entry.session.binding.upstreamSessionId
    entry.state = "retiring"
    await entry.rpc.retire(codexRetirementDeadline(this.services))
    this.entries.delete(entry.start.sessionId)
    await this.open(start, entry.broker, threadId)
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry) return
    entry.state = "retiring"
    entry.providerTurn?.queue.fail(new CodexTransportError("process", "Codex process retired during provider turn"))
    entry.providerTurn = undefined
    await entry.rpc.retire(codexRetirementDeadline(this.services))
    this.entries.delete(session.binding.sessionId)
    this.losses.recovered(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposeAbort.abort()
    for (const rpc of this.starting) await rpc.retire(codexRetirementDeadline(this.services))
    for (const entry of this.entries.values()) await this.close(entry.session)
  }
}
