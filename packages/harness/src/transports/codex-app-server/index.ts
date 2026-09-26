import { prefixedRandomId, stringRecord } from "@claxedo/helpers"
import type { RuntimeGoalSnapshot, SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type {
  AttachInput, ConfigApplied, Deadline, DraftLaunch, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, draftProbeKey, DraftProbeCache, mergeStartInput } from "../../contract"
import { prepareCodexProfile } from "../../profiles/codex"
import { projectCodexThreadConfig } from "./configuration"
import { createCodexConfig } from "./config"
import { codexCapabilities, codexCapabilityDraft } from "./capabilities"
import { codexThreadResumeParams, codexThreadStartParams, codexTurnInput } from "./input"
import { codexPermissionSettings } from "./modes"
import { CodexEvents, publishCodexQuota } from "./events"
import { CodexRequestRefusal, CodexTransportError } from "./errors"
import { snapshotFromCodexGoal, createCodexGoals } from "./goals"
import { readCodexModels, type CodexModel } from "./models"
import { admitCodexProviderTurn, type CodexProviderTurn } from "./provider-turn"
import { answerCodexRequest, isCodexRequestMethod } from "./requests"
import { CodexRpc, codexRetirementDeadline, type RpcMessage } from "./rpc"
import { answerCodexToolCall, type CodexTurnSettings } from "./subagents"
import { CodexTerminals } from "./terminals"
import { codexRename, codexSessionTitle } from "./titles"
import { runCodexTurn } from "./turn"
import { CodexUsageLedger, type ThreadOwnership } from "./usage"

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
  turn?: { broker: TurnBroker; id?: string; settings: CodexTurnSettings }
}

export type CodexTransportOptions = { binary: string; homeRoot: string; ownerHome?: string; env?: NodeJS.ProcessEnv }

export class CodexAppServerTransport implements HarnessTransport {
  readonly kind = "codex-app-server" as const
  private readonly entries = new Map<string, Entry>()
  private readonly starting = new Set<CodexRpc>()
  private readonly probes: DraftProbeCache<CodexModel[]>
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {
    this.probes = new DraftProbeCache(services.clock)
  }

  async capabilities(context: { sessionId?: string; directory: string }) {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : [...this.entries.values()].find((item) => item.session.directory === context.directory)
    const models = entry ? await this.models(entry) : await this.probeDraftModels(codexCapabilityDraft(context.directory), "probe")
    return codexCapabilities(models)
  }

  private async launch(input: StartInput): Promise<{ rpc: CodexRpc; home: string; brokered: boolean }> {
    if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed")
    const profile = await prepareCodexProfile({ homeRoot: this.options.homeRoot, owner: input.owner, credentials: input.credentials,
      projection: input.projection, ownerHome: this.options.ownerHome })
    const env = stringRecord(this.options.env ?? process.env)
    env.CODEX_HOME = profile.home
    const owned = await this.services.spawn({ file: this.options.binary, args: ["app-server", "--listen", "stdio://"], cwd: input.directory, env },
      { role: "harness", label: "Codex app-server", sessionId: input.sessionId })
    const rpc = new CodexRpc(owned, this.services.clock)
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
      const session: HarnessSession = { directory: input.directory, locality: input.locality, binding: {
        sessionId: input.sessionId, workspaceId: input.workspaceId, directory: input.directory,
        connectionId: "codex-app-server", upstreamSessionId: threadId,
      } }
      const entry: Entry = { state: "ready", start: input, session, broker, rpc, home, brokered,
        terminals: new CodexTerminals(rpc, threadId), children: new Map(), sideThreads: new Set(), usage: new CodexUsageLedger(), goal: null }
      rpc.onRequest((message) => this.answer(entry, message))
      rpc.onMessage((message) => this.outsideTurn(entry, message))
      rpc.onFailure((error) => {
        entry.state = "retiring"
        entry.providerTurn?.queue.fail(error)
      })
      await broker.rebind(threadId)
      if (entry.state === "retiring") throw new CodexTransportError("process", "Codex process retired during rebind")
      this.entries.set(input.sessionId, entry)
      this.starting.delete(rpc)
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
    const cached = this.probes.get(key)
    if (cached) return cached
    if (mode === "peek") return Promise.resolve([])
    return this.probes.set(key, this.probeModels({ ...draft, sessionId: prefixedRandomId("probe", "-") }))
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

  private observeUsage(entry: Entry, message: RpcMessage): void {
    const threadId = asString(asRecordOrEmpty(message.params).threadId)
    const streaming = entry.state === "busy" || entry.providerTurn !== undefined
    const ownership: ThreadOwnership = !threadId ? "unknown"
      : threadId === entry.session.binding.upstreamSessionId || entry.children.has(threadId) ? (streaming ? "owned" : "detached")
        : entry.sideThreads.has(threadId) ? "side" : "unknown"
    const { usage, unbilled } = entry.usage.observe(message, ownership)
    if (usage) entry.broker.meter(usage)
    if (unbilled) void entry.broker.publish({ type: "diagnostic", diagnostic: { code: "codex.usage_unbilled", severity: "warn", source: "codex.app-server",
      method: "thread/tokenUsage/updated", message: `Codex reported usage for thread ${unbilled}, which no turn of this session can be billed for` } })
      .catch((error: unknown) => entry.broker.reportFailure(error))
  }

  private outsideTurn(entry: Entry, message: RpcMessage): void {
    const params = asRecordOrEmpty(message.params)
    entry.terminals.observe(message)
    this.observeUsage(entry, message)
    if (message.method === "account/rateLimits/updated") {
      if (entry.state !== "busy" && !entry.providerTurn) {
        void publishCodexQuota(entry.broker, entry.session.binding.upstreamSessionId, message)
          .catch((error: unknown) => entry.broker.reportFailure(error))
      }
      return
    }
    const threadId = asString(params.threadId)
    const child = threadId ? entry.children.get(threadId) : undefined
    if (threadId && child) {
      if (entry.providerTurn) for (const event of child.ingest(message)) entry.providerTurn.queue.push({ ...event, route: { kind: "child", correlationKey: threadId } })
      return
    }
    if (threadId === entry.session.binding.upstreamSessionId) this.sessionThreadNotification(entry, message)
  }

  private sessionThreadNotification(entry: Entry, message: RpcMessage): void {
    const params = asRecordOrEmpty(message.params)
    if (message.method === "thread/goal/updated" || message.method === "thread/goal/cleared") {
      entry.goal = message.method === "thread/goal/cleared" ? null : snapshotFromCodexGoal(entry.session.binding.sessionId, params.goal)
      void entry.broker.goal.publish(entry.goal).catch((error: unknown) => entry.broker.reportFailure(error))
      return
    }
    if (entry.providerTurn) {
      const events = entry.providerTurn.events.ingest(message)
      for (const event of events) entry.providerTurn.queue.push(event)
      if (message.method === "turn/completed" && asString(asRecordOrEmpty(params.turn).id) === entry.providerTurn.id) {
        entry.providerTurn.queue.end()
        entry.providerTurn = undefined
      }
      return
    }
    if (entry.state !== "busy" && message.method !== "turn/started") {
      for (const item of new CodexEvents(entry.session.binding.upstreamSessionId).ingest(message)) {
        if (item.event.type === "diagnostic" && item.event.diagnostic.code === "unrecognized-event") {
          void entry.broker.publish(item.event).catch((error: unknown) => entry.broker.reportFailure(error))
        }
      }
    }
    if (message.method !== "turn/started" || entry.state === "busy" || entry.goal?.status !== "active") return
    admitCodexProviderTurn(entry, message)
  }

  readonly goals = createCodexGoals((session) => this.entry(session))

  readonly naming = {
    generateTitle: (session: HarnessSession, request: SessionTitleRequest) => codexSessionTitle(this.entry(session), request, this.services),
    rename: (session: HarnessSession, name: string) => codexRename(this.entry(session), session.binding.upstreamSessionId, name),
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    entry.usage.attach({ sessionId: session.binding.sessionId, directory: session.directory, assistantMessageId: turn.assistantMessageId })
    yield* runCodexTurn(entry, session, turn, broker, this.services, () => this.models(entry),
      () => this.cancel(session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId }, codexRetirementDeadline(this.services)))
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (entry.state !== "busy" || !entry.turn?.id) return { execution: "unknown" as const, cleanup: "unknown" as const }
    return entry.terminals.stop(entry.turn.id, deadline)
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
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const rpc of this.starting) await rpc.retire(codexRetirementDeadline(this.services))
    for (const entry of this.entries.values()) await this.close(entry.session)
  }
}
