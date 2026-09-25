import path from "node:path"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type {
  AttachInput, ConfigApplied, Deadline, HarnessServices, HarnessSession, HarnessTransport, McpServerSpec,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { prepareCodexProfile } from "../../profiles/codex"
import type { JsonValue, v2 } from "@claxedo/agent-event-runtime/harnesses/codex"
import { CodexEvents, CodexEventQueue, publishCodexQuota } from "./events"
import { CodexTransportError } from "./errors"
import { snapshotFromCodexGoal, createCodexGoals } from "./goals"
import { answerCodexRequest } from "./requests"
import { startCodexTurn } from "./recovery"
import { CodexRpc, type RpcMessage } from "./rpc"

type Entry = {
  state: "ready" | "busy" | "retiring"
  start: StartInput
  session: HarnessSession
  broker: SessionBroker
  rpc: CodexRpc
  goal: RuntimeGoalSnapshot | null
  providerTurn?: { id: string; queue: CodexEventQueue<RoutedEvent>; events: CodexEvents }
  turn?: { broker: TurnBroker; id?: string }
}

export type CodexTransportOptions = { binary: string; homeRoot: string; ownerHome?: string; env?: NodeJS.ProcessEnv }

function mcpConfig(server: McpServerSpec): Record<string, JsonValue> {
  if (server.kind === "stdio") return { command: server.command, args: [...(server.args ?? [])], env: server.env ?? {}, ...(server.cwd ? { cwd: server.cwd } : {}) }
  if (server.kind === "sse") throw new CodexTransportError("configuration", `Codex cannot load SSE MCP server ${server.name}`)
  return { url: server.url, http_headers: server.headers ?? {} }
}

export function projectCodexThreadConfig(input: StartInput, services: HarnessServices): Record<string, JsonValue> {
  const servers = [...input.projection.mcpServers]
  const first = input.locality === "local" ? services.firstPartyMcp(input.sessionId, input.locality) : undefined
  if (first) servers.push({ ...first, origin: "first-party" })
  const mcp = Object.fromEntries(servers.map((server) => [server.name, mcpConfig(server)]))
  if (Object.keys(mcp).length !== servers.length) throw new CodexTransportError("configuration", "Duplicate Codex MCP server name")
  return { features: { default_mode_request_user_input: true }, tools: { update_plan: { enabled: true } }, mcp_servers: mcp }
}

function codexRetirementDeadline(services: HarnessServices): Deadline {
  return { at: services.clock.now() + 10_000, signal: new AbortController().signal }
}

function reasoningEffort(value: string | null | undefined): v2.TurnStartParams["effort"] {
  if (value == null) return undefined
  if (value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value
  throw new CodexTransportError("configuration", `Unsupported Codex effort ${value}`)
}

function userInput(turn: TurnInput): v2.UserInput[] {
  const prefix = turn.system ? `${turn.system}\n\n` : ""
  const parts = turn.prompt.parts.flatMap((part): v2.UserInput[] => {
    if (part.type === "text") return [{ type: "text", text: part.text, text_elements: [] }]
    if (part.type === "file" && part.url.startsWith("data:image/")) return [{ type: "image", url: part.url }]
    throw new CodexTransportError("configuration", "Codex prompt attachment is unsupported")
  })
  if (prefix && parts[0]?.type === "text") parts[0].text = prefix + parts[0].text
  else if (prefix) parts.unshift({ type: "text", text: prefix, text_elements: [] })
  return parts
}

export class CodexAppServerTransport implements HarnessTransport {
  readonly kind = "codex-app-server" as const
  private readonly entries = new Map<string, Entry>()
  private readonly starting = new Set<CodexRpc>()
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: CodexTransportOptions) {}

  async capabilities(): Promise<TransportCapabilities> {
    return {
      modelSelection: { status: "required", models: [] }, effortLevels: { status: "unresolved", models: [] },
      instructionChannel: "thread-start", configOwner: "runtime",
      requests: { permissions: true, questions: true, elicitation: true },
      steer: true, subagents: false,
      goals: { implemented: true, available: true, actions: ["pause", "resume", "delete"], recovery: "reconcile", optionalFields: ["tokenBudget", "tokensUsed", "timeUsedSeconds"] },
      fork: false, agents: false, commands: false, todos: true, history: "store", titles: "none",
      pluginIntake: { mcp: "config", skills: "plugin-dir" },
      mcpTransports: { stdio: true, http: true, sse: false },
      timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "after-active-turns" },
    }
  }

  private async launch(input: StartInput): Promise<CodexRpc> {
    if (this.disposed) throw new CodexTransportError("process", "Codex transport disposed")
    const home = path.join(this.options.homeRoot, input.sessionId)
    const profile = await prepareCodexProfile({ home, credentials: input.credentials, projection: input.projection, ownerHome: this.options.ownerHome })
    const env = Object.fromEntries(Object.entries(this.options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    delete env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN
    env.CODEX_HOME = profile.home
    const owned = await this.services.spawn({ file: this.options.binary, args: ["app-server", "--listen", "stdio://"], cwd: input.directory, env },
      { role: "harness", label: "Codex app-server", sessionId: input.sessionId })
    const rpc = new CodexRpc(owned, this.services.clock)
    this.starting.add(rpc)
    try {
      await rpc.request("initialize", { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } })
      rpc.notify("initialized")
      return rpc
    } catch (error) {
      await rpc.retire(codexRetirementDeadline(this.services))
      this.starting.delete(rpc)
      throw error
    }
  }

  private async open(input: StartInput, broker: SessionBroker, resumed?: string): Promise<HarnessSession> {
    const rpc = await this.launch(input)
    try {
      const config = projectCodexThreadConfig(input, this.services)
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
      const entry: Entry = { state: "ready", start: input, session, broker, rpc, goal: null }
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

  private async answer(entry: Entry, message: RpcMessage): Promise<unknown> {
    if (!message.method || (!entry.turn && !entry.providerTurn)) throw new CodexTransportError("protocol", "Codex request has no active turn")
    return answerCodexRequest(message, entry.turn?.broker ?? entry.broker, entry.session.binding.sessionId)
  }

  private outsideTurn(entry: Entry, message: RpcMessage): void {
    const params = asRecordOrEmpty(message.params)
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
    this.beginProviderTurn(entry, message, params)
  }

  private beginProviderTurn(entry: Entry, message: RpcMessage, params: Record<string, unknown>): void {
    const id = asString(asRecordOrEmpty(params.turn).id) ?? ""
    if (!id) return
    const queue = new CodexEventQueue<RoutedEvent>()
    entry.providerTurn = { id, queue, events: new CodexEvents(entry.session.binding.upstreamSessionId) }
    for (const event of entry.providerTurn.events.ingest(message)) queue.push(event)
    void entry.broker.admitProviderTurn({ reason: "goal" }, async function* () {
      for (;;) {
        const next = await queue.next()
        if (next.done) return
        yield next.value
      }
    }).then((result) => {
      if (!result.admitted) { queue.end(); entry.providerTurn = undefined }
      else void result.settled.then((settlement) => {
        if (settlement.state === "failed") entry.broker.reportFailure(new CodexTransportError("session", settlement.error))
        if (settlement.state !== "completed") { queue.end(); entry.providerTurn = undefined }
      })
    }, (error: unknown) => { queue.fail(error); entry.broker.reportFailure(error) })
  }

  readonly goals = createCodexGoals((session) => this.entry(session))

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.state !== "ready") throw new CodexTransportError("session", "Codex turn already active")
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
    const onAbort = () => { void this.cancel(session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId }, codexRetirementDeadline(this.services)) }
    broker.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const params: v2.TurnStartParams = { threadId: session.binding.upstreamSessionId, input: userInput(turn), cwd: session.directory,
        ...(turn.model?.modelID && turn.model.modelID !== "default" ? { model: turn.model.modelID } : {}),
        ...(turn.effort ? { effort: reasoningEffort(turn.effort) } : {}),
        ...(turn.prompt.serviceTier !== undefined ? { serviceTier: turn.prompt.serviceTier } : {}),
        approvalPolicy: "on-request", approvalsReviewer: "user" }
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

  async cancel(session: HarnessSession, _turn: TurnRef, _deadline: Deadline) {
    const entry = this.entry(session)
    if (entry.state !== "busy" || !entry.turn?.id) return { execution: "unknown" as const, cleanup: "unknown" as const }
    await entry.rpc.request("turn/interrupt", { threadId: session.binding.upstreamSessionId, turnId: entry.turn.id })
    return { execution: "unknown" as const, cleanup: "unknown" as const }
  }

  readonly steer = { steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
    const entry = this.entry(session)
    if (!entry.turn?.id) return { ok: false as const, status: "no_active_turn" as const, message: "No active Codex turn" }
    await entry.rpc.request("turn/steer", { threadId: session.binding.upstreamSessionId, expectedTurnId: entry.turn.id, input: userInput(input) })
    return { ok: true as const }
  } }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (!update.credentials && !update.projection) return { state: "applied" }
    if (entry.state === "busy") return { state: "refused", reason: "Codex turn is active" }
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
    await entry.rpc.retire(codexRetirementDeadline(this.services))
    this.entries.delete(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const rpc of this.starting) await rpc.retire(codexRetirementDeadline(this.services))
    for (const entry of this.entries.values()) await this.close(entry.session)
  }
}
