import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type {
  AttachInput, ConfigApplied, Deadline, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { prepareCodexProfile } from "../../profiles/codex"
import { refreshCodexChatgptTokens, type CodexAuthFetch } from "../../profiles/codex/auth"
import type { v2 } from "@claxedo/agent-event-runtime/harnesses/codex"
import { projectCodexThreadConfig } from "./configuration"
import { createCodexConfig } from "./config"
import { codexCapabilities, codexCapabilityDraft } from "./capabilities"
import { codexTurnParams, codexInlineUserInput } from "./input"
import { CodexEvents, CodexEventQueue, publishCodexQuota } from "./events"
import { CodexRequestRefusal, CodexTransportError } from "./errors"
import { snapshotFromCodexGoal, createCodexGoals } from "./goals"
import { codexTurnSettings, readCodexModels, type CodexModel } from "./models"
import { admitCodexProviderTurn, type CodexProviderTurn } from "./provider-turn"
import { answerCodexRequest } from "./requests"
import { startCodexTurn } from "./recovery"
import { CodexRpc, codexRetirementDeadline, type RpcMessage } from "./rpc"
import { CodexTerminals } from "./terminals"

type Entry = {
  state: "ready" | "busy" | "retiring"
  start: StartInput
  session: HarnessSession
  broker: SessionBroker
  rpc: CodexRpc
  home: string
  brokered: boolean
  terminals: CodexTerminals
  goal: RuntimeGoalSnapshot | null
  models?: Promise<CodexModel[]>
  providerTurn?: CodexProviderTurn
  turn?: { broker: TurnBroker; id?: string }
}

export type CodexTransportOptions = { binary: string; homeRoot: string; ownerHome?: string; env?: NodeJS.ProcessEnv; fetch?: CodexAuthFetch }

export class CodexAppServerTransport implements HarnessTransport {
  readonly kind = "codex-app-server" as const
  private readonly entries = new Map<string, Entry>()
  private readonly starting = new Set<CodexRpc>()
  private readonly modelProbes = new Map<string, Promise<CodexModel[]>>()
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {}

  async capabilities(context: { sessionId?: string; directory: string }) {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : [...this.entries.values()].find((item) => item.session.directory === context.directory)
    const models = entry ? await this.models(entry) : await this.probeDraftModels(codexCapabilityDraft(context.directory), "probe", true)
    return codexCapabilities(models)
  }

  private async launch(input: StartInput, isolatedHome = false): Promise<{ rpc: CodexRpc; home: string; brokered: boolean }> {
    if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed")
    const home = path.join(this.options.homeRoot, input.sessionId)
    if (isolatedHome) await fs.mkdir(home, { recursive: true, mode: 0o700 })
    const profile = await prepareCodexProfile({ home, credentials: input.credentials, projection: input.projection,
      ownerHome: isolatedHome ? home : this.options.ownerHome })
    const env = Object.fromEntries(Object.entries(this.options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    delete env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN
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
      if (isolatedHome) await fs.rm(home, { recursive: true, force: true })
      throw error
    }
  }

  private async open(input: StartInput, broker: SessionBroker, resumed?: string): Promise<HarnessSession> {
    const { rpc, home, brokered } = await this.launch(input)
    try {
      const config = projectCodexThreadConfig(input, this.services)
      if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed during startup")
      const model = input.model?.modelID === "default" ? undefined : input.model?.modelID
      const params: v2.ThreadStartParams = { cwd: input.directory, ...(model ? { model } : {}),
        ...(input.credentials.providers.codex ? { modelProvider: "broker" } : {}),
        approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", config,
        ...(input.instructions ? { developerInstructions: input.instructions } : {}) }
      const result = asRecordOrEmpty(await rpc.request(resumed ? "thread/resume" : "thread/start", resumed ? { threadId: resumed, cwd: input.directory, config } : params))
      const threadId = asString(asRecordOrEmpty(result.thread).id) ?? ""
      if (!threadId || (resumed && threadId !== resumed)) throw new CodexTransportError("session", "Codex returned a different or missing thread")
      const session: HarnessSession = { directory: input.directory, locality: input.locality, binding: {
        sessionId: input.sessionId, workspaceId: input.workspaceId, directory: input.directory,
        connectionId: "codex-app-server", upstreamSessionId: threadId,
      } }
      const entry: Entry = { state: "ready", start: input, session, broker, rpc, home, brokered,
        terminals: new CodexTerminals(rpc, threadId), goal: null }
      rpc.onRequest((message) => this.answer(entry, message))
      rpc.onMessage((message) => this.outsideTurn(entry, message))
      this.entries.set(input.sessionId, entry)
      this.starting.delete(rpc)
      await broker.rebind(threadId)
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
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry || entry.session.binding.upstreamSessionId !== session.binding.upstreamSessionId || entry.state === "retiring") {
      throw new CodexTransportError("session", "Codex session is not attached")
    }
    return entry
  }

  private models(entry: Entry): Promise<CodexModel[]> {
    entry.models ??= readCodexModels(entry.rpc)
    return entry.models
  }

  readonly config = createCodexConfig({
    entry: (session) => this.entry(session), models: (entry) => this.models(entry),
    probe: (draft, mode) => this.probeDraftModels(draft, mode),
  })

  private probeDraftModels(draft: Omit<StartInput, "sessionId" | "title" | "instructions">, mode: "probe" | "peek",
    isolatedHome = false): Promise<CodexModel[]> {
    const key = JSON.stringify([draft, isolatedHome])
    const cached = this.modelProbes.get(key)
    if (cached) return cached
    if (mode === "peek") return Promise.resolve([])
    const probe = this.probeModels({ ...draft, sessionId: `probe-${randomUUID()}` }, isolatedHome)
    this.modelProbes.set(key, probe)
    void probe.then(undefined, () => this.modelProbes.delete(key))
    return probe
  }

  private async probeModels(input: StartInput, isolatedHome = false): Promise<CodexModel[]> {
    const { rpc } = await this.launch(input, isolatedHome)
    try { return await readCodexModels(rpc) }
    finally {
      this.starting.delete(rpc)
      try { await rpc.retire(codexRetirementDeadline(this.services)) }
      finally { if (isolatedHome) await fs.rm(path.join(this.options.homeRoot, input.sessionId), { recursive: true, force: true }) }
    }
  }

  private async answer(entry: Entry, message: RpcMessage): Promise<unknown> {
    if (message.method === "account/chatgptAuthTokens/refresh") {
      if (entry.brokered) throw new CodexRequestRefusal(-32000, "ChatGPT token refresh is unavailable for a brokered Codex account")
      try { return await refreshCodexChatgptTokens(entry.home, this.options.fetch) }
      catch (error) { throw new CodexRequestRefusal(-32000, `Codex ChatGPT token refresh failed: ${String(error)}`) }
    }
    if (!message.method) throw new CodexRequestRefusal(-32600, "Codex request has no method")
    if (!entry.turn && !entry.providerTurn && message.method !== "item/tool/call") {
      throw new CodexRequestRefusal(-32000, "Codex request has no active turn")
    }
    return answerCodexRequest(message, entry.turn?.broker ?? entry.broker, entry.session.binding.sessionId,
      { directory: entry.session.directory, permissionMode: entry.start.config.permissionMode })
  }

  private outsideTurn(entry: Entry, message: RpcMessage): void {
    const params = asRecordOrEmpty(message.params)
    entry.terminals.observe(message)
    if (message.method === "account/rateLimits/updated") {
      if (entry.state !== "busy" && !entry.providerTurn) {
        void publishCodexQuota(entry.broker, entry.session.binding.upstreamSessionId, message)
          .catch((error: unknown) => entry.broker.reportFailure(error))
      }
      return
    }
    if (asString(params.threadId) !== entry.session.binding.upstreamSessionId) return
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

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.state !== "ready" || entry.providerTurn) throw new CodexTransportError("session", "Codex turn already active")
    entry.state = "busy"
    entry.turn = { broker }
    const queue = new CodexEventQueue<RoutedEvent>()
    const events = new CodexEvents(session.binding.upstreamSessionId)
    const remove = entry.rpc.onMessage((message) => {
      if (!message.method || (message.method !== "account/rateLimits/updated"
        && asString(asRecordOrEmpty(message.params).threadId) !== session.binding.upstreamSessionId)) return
      try {
        for (const event of events.ingest(message)) queue.push(event)
        if (message.method === "turn/started") entry.turn!.id = asString(asRecordOrEmpty(asRecordOrEmpty(message.params).turn).id) ?? ""
        if (message.method === "turn/completed") queue.end()
      } catch (error) { queue.fail(error) }
    })
    void entry.rpc.process.exited.then(() => queue.fail(new CodexTransportError("process", "Codex exited during turn")))
    const onAbort = () => { void this.cancel(session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId },
      codexRetirementDeadline(this.services)).catch((error: unknown) => entry.broker.reportFailure(error)) }
    broker.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const settings = codexTurnSettings(await this.models(entry), {
        model: turn.model?.modelID ?? entry.start.config.model?.modelID ?? entry.start.model?.modelID,
        effort: turn.effort, serviceTier: turn.prompt.serviceTier,
      })
      const params = codexTurnParams(turn, session.binding.upstreamSessionId, session.directory, settings)
      const result = asRecordOrEmpty(await startCodexTurn(entry.rpc, params, projectCodexThreadConfig(entry.start, this.services)))
      entry.turn.id = asString(asRecordOrEmpty(result.turn).id) ?? entry.turn.id ?? ""
      for (;;) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      remove()
      broker.signal.removeEventListener("abort", onAbort)
      entry.turn = undefined
      entry.state = "ready"
    }
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (entry.state !== "busy" || !entry.turn?.id) return { execution: "unknown" as const, cleanup: "unknown" as const }
    return entry.terminals.stop(entry.turn.id, deadline)
  }

  readonly steer = { steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
    const entry = this.entry(session)
    if (!entry.turn?.id) return { ok: false as const, status: "no_active_turn" as const, message: "No active Codex turn" }
    await entry.rpc.request("turn/steer", { threadId: session.binding.upstreamSessionId, expectedTurnId: entry.turn.id, input: codexInlineUserInput(input) })
    return { ok: true as const }
  } }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (!update.credentials && !update.projection) return { state: "applied" }
    if (entry.state === "busy" || entry.providerTurn) return { state: "refused", reason: "Codex turn is active" }
    const start = { ...entry.start, ...(update.credentials ? { credentials: update.credentials } : {}),
      ...(update.projection ? { projection: update.projection } : {}) }
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
