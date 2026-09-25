import { translateStopReason } from "@claxedo/agent-event-runtime/harnesses/acp"
import type { CreateElicitationRequest, RequestPermissionRequest, SessionNotification, SessionConfigOption } from "@agentclientprotocol/sdk"
import type {
  AttachInput, ConfigApplied, HarnessServices, HarnessSession, HarnessTransport, McpServerSpec,
  ProjectedMcpServer, RoutedEvent, SessionBroker, StartInput, TransportCapabilities,
  TransportConfigUpdate, TurnBroker, TurnInput, TurnRef, Deadline,
} from "../../contract"
import { connectAcp, type AcpConnectionOptions, type AcpPeer } from "./connection"
import { AcpTransportError } from "./errors"
import { AcpQueue } from "./queue"
import { acpElicitation, acpMcp, acpPermission, acpPrompt } from "./protocol"
import { restoreAcp } from "./restore"
import type { MissingSessionContext } from "./restore"
import { claudeOptionsMeta } from "./extensions/claude-options"
import { AcpStartupDeadline } from "./deadline"
import { AcpQuiet } from "./quiet"
import { acpObserveSubagent, acpReceiver, acpUnknown, acpUpdate } from "./events"
import { acpConfig } from "./config"
import { supportsAcpSubagents } from "./extensions/subagents"
import { AcpDraftProbes } from "./probe"

export type AcpMcpFilter = (input: {
  servers: readonly ProjectedMcpServer[]
  locality: "local" | "remote"
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean }
  supportsMcpServers?: boolean
}) => { servers: ProjectedMcpServer[]; notApplied: { item: string; reason: string }[] }

export type AcpEntry = {
  session: HarnessSession
  start: StartInput
  broker: SessionBroker
  peer: AcpPeer
  queue?: AcpQueue<RoutedEvent>
  receive?: (notification: SessionNotification) => void
  turnBroker?: TurnBroker
  phase: "ready" | "busy" | "uncertain"
  cancelled: boolean
  pendingRestart: boolean
  quiet?: AcpQuiet
  startup?: AcpStartupDeadline
  startupAbort: AbortController
  cancelSent?: Promise<void>
  commands: { name: string; description?: string }[]
  options: SessionConfigOption[]
}

export class AcpTransport implements HarnessTransport {
  readonly kind = "acp" as const
  private readonly entries = new Map<string, AcpEntry>()
  private readonly starting = new Set<AcpEntry>()
  private readonly startingAborts = new Set<AbortController>()
  private readonly probes: AcpDraftProbes
  private disposed = false
  readonly health = {
    connection: (_directory: string, sessionId?: string) => ({ state: sessionId && !this.entries.has(sessionId) ? "disconnected" as const : "ready" as const, processes: [] }),
    runtime: (_directory: string, sessionId?: string) => ({ status: sessionId && !this.entries.has(sessionId) ? "unavailable" as const : "ok" as const }),
  }
  private readonly commandOperations = { list: async (directory: string) => this.byDirectory(directory).commands }
  private readonly configOperations = acpConfig((session: HarnessSession) => this.entry(session), (draft, mode) => this.probes.options(draft, mode))
  private readonly forkOperations = { fork: async (session: HarnessSession, _messageId: string) => {
    const entry = this.entry(session)
    const result = await entry.peer.agent.unstable_forkSession({ sessionId: session.binding.upstreamSessionId,
      cwd: session.directory, mcpServers: this.mcp(entry).map(acpMcp) })
    return { upstreamSessionId: result.sessionId }
  } }
  get commands() { return [...this.entries.values()].some((entry) => entry.commands.length > 0) ? this.commandOperations : undefined }
  get config() { return this.configOperations }
  get fork() { return [...this.entries.values()].some((entry) => entry.peer.handshake.agentCapabilities?.sessionCapabilities?.fork) ? this.forkOperations : undefined }

  constructor(private readonly services: HarnessServices, private readonly connection: AcpConnectionOptions,
    private readonly filterMcp: AcpMcpFilter, private readonly missingContext: MissingSessionContext) {
    this.probes = new AcpDraftProbes(services, connection, filterMcp)
  }

  async capabilities(context: { sessionId?: string; directory: string }): Promise<TransportCapabilities> {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : [...this.entries.values()].find((item) => item.session.directory === context.directory)
    const declared = entry?.peer.handshake.agentCapabilities
    const mcp = declared?.mcpCapabilities
    return {
      modelSelection: { status: "optional" }, effortLevels: { status: "unresolved", models: [] },
      instructionChannel: "prompt-prefix", configOwner: "harness",
      requests: { permissions: true, questions: false, elicitation: true },
      steer: false, subagents: Boolean(entry && supportsAcpSubagents(entry.peer.handshake)),
      goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
      fork: Boolean(declared?.sessionCapabilities?.fork), agents: false, commands: Boolean(entry?.commands.length), todos: false,
      history: "store", titles: "none", pluginIntake: { mcp: this.connection.supportsMcpServers === false ? "none" : "session", skills: "none" },
      mcpTransports: { stdio: this.connection.kind === "process" && this.connection.supportsMcpServers !== false,
        http: this.connection.supportsMcpServers !== false && mcp?.http === true,
        sse: this.connection.supportsMcpServers !== false && mcp?.sse === true },
      timing: { model: "immediate", effort: "immediate", permissionMode: "immediate", credentials: "after-active-turns" },
    }
  }

  private byDirectory(directory: string): AcpEntry {
    const entry = [...this.entries.values()].find((item) => item.session.directory === directory)
    if (!entry) throw new AcpTransportError("session", "ACP directory has no session")
    return entry
  }

  private entry(session: HarnessSession): AcpEntry {
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry || entry.session.binding.upstreamSessionId !== session.binding.upstreamSessionId) throw new AcpTransportError("session", "ACP session is not attached")
    return entry
  }

  private mcp(entry: Pick<AcpEntry, "start" | "peer">): McpServerSpec[] {
    const first = this.services.firstPartyMcp(entry.start.sessionId, entry.start.locality)
    const servers = [...entry.start.projection.mcpServers, ...(first ? [{ ...first, origin: "first-party" as const }] : [])]
    return this.filterMcp({ servers, locality: entry.start.locality,
      mcpCapabilities: entry.peer.handshake.agentCapabilities?.mcpCapabilities,
      supportsMcpServers: this.connection.supportsMcpServers }).servers
  }

  private async open(input: StartInput, broker: SessionBroker): Promise<AcpEntry> {
    if (this.disposed) throw new AcpTransportError("connection", "ACP transport disposed")
    let entry: AcpEntry | undefined
    const startupAbort = new AbortController()
    this.startingAborts.add(startupAbort)
    let peer: AcpPeer
    try { peer = await connectAcp(input, this.connection, this.services, {
      permission: (request) => this.permission(entry, broker, request, startupAbort.signal),
      elicitation: (request) => this.elicitation(entry, broker, request, startupAbort.signal),
      complete: (notification) => (entry?.turnBroker ?? broker).completeElicitation(notification.elicitationId),
      update: (notification) => acpUpdate(entry, notification, (update) => acpObserveSubagent(entry, update)),
      extension: (_sessionId, update) => acpObserveSubagent(entry, update),
      unknown: (sessionId, method, payload) => acpUnknown(entry, sessionId, method, payload),
    }) } catch (error) { this.startingAborts.delete(startupAbort); throw error }
    if (this.disposed) { this.startingAborts.delete(startupAbort); await peer.retire(); throw new AcpTransportError("connection", "ACP transport disposed during startup") }
    entry = { start: input, broker, peer, phase: "ready", cancelled: false, pendingRestart: false, commands: [], options: [], startupAbort,
      session: { binding: { sessionId: input.sessionId, workspaceId: input.workspaceId, directory: input.directory,
        connectionId: input.config.harness.id, upstreamSessionId: "" }, directory: input.directory, locality: input.locality } }
    this.starting.add(entry)
    return entry
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    const entry = await this.open(input, broker)
    try {
      const meta = claudeOptionsMeta(entry.peer.handshake, input)
      entry.startup = new AcpStartupDeadline(this.services.clock, this.connection.startupTimeoutMs ?? 10_000, "session/new")
      const result = await entry.startup.run(entry.peer.agent.newSession({ cwd: input.directory, mcpServers: this.mcp(entry).map(acpMcp),
        ...(meta ? { _meta: meta } : {}) }))
      entry.startup = undefined
      entry.session.binding.upstreamSessionId = result.sessionId
      entry.options = result.configOptions ?? []
      await broker.rebind(result.sessionId)
      if (this.disposed) throw new AcpTransportError("connection", "ACP transport disposed during startup")
      this.starting.delete(entry)
      this.startingAborts.delete(entry.startupAbort)
      this.entries.set(input.sessionId, entry)
      return entry.session
    } catch (error) { this.starting.delete(entry); this.startingAborts.delete(entry.startupAbort); await entry.peer.retire(); throw error }
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    const entry = await this.open(input, broker)
    try {
      const upstreamSessionId = await restoreAcp(entry.peer, input, this.mcp(entry).map(acpMcp), broker, this.missingContext)
      entry.session.binding = { ...input.binding, upstreamSessionId }
      await broker.rebind(upstreamSessionId)
      if (this.disposed) throw new AcpTransportError("connection", "ACP transport disposed during attach")
      this.starting.delete(entry)
      this.startingAborts.delete(entry.startupAbort)
      this.entries.set(input.sessionId, entry)
      return entry.session
    } catch (error) { this.starting.delete(entry); this.startingAborts.delete(entry.startupAbort); await entry.peer.retire(); throw error }
  }

  private async permission(entry: AcpEntry | undefined, broker: SessionBroker, request: RequestPermissionRequest,
    startupSignal: AbortSignal) {
    if (entry?.session.binding.upstreamSessionId && request.sessionId !== entry.session.binding.upstreamSessionId) return { outcome: { outcome: "cancelled" as const } }
    const release = entry?.startup?.hold() ?? entry?.quiet?.hold()
    try {
      const response = await acpPermission(request, entry?.turnBroker ?? broker, broker.sessionId,
        entry?.turnBroker ? undefined : { signal: startupSignal })
      return entry?.cancelled ? { outcome: { outcome: "cancelled" as const } } : response
    } finally { release?.() }
  }

  private async elicitation(entry: AcpEntry | undefined, broker: SessionBroker, request: CreateElicitationRequest,
    startupSignal: AbortSignal) {
    const release = entry?.startup?.hold() ?? entry?.quiet?.hold()
    try { return await acpElicitation(request, entry?.turnBroker ?? broker,
      entry?.turnBroker ? undefined : { signal: startupSignal }) }
    finally { release?.() }
  }

  private quiet(entry: AcpEntry, session: HarnessSession, queue: AcpQueue<RoutedEvent>): AcpQuiet {
    return new AcpQuiet(this.services.clock, this.connection.promptTimeoutMs ?? 300_000, () => {
      entry.phase = "uncertain"
      entry.cancelSent = entry.peer.agent.cancel({ sessionId: session.binding.upstreamSessionId })
      queue.fail(new AcpTransportError("timeout", "ACP prompt outcome is uncertain"))
    })
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.phase !== "ready") throw new AcpTransportError("session", entry.phase === "uncertain" ? "ACP session outcome is uncertain" : "ACP session already has an active turn")
    entry.phase = "busy"
    entry.cancelled = false
    entry.turnBroker = broker
    const queue = new AcpQueue<RoutedEvent>()
    entry.queue = queue
    entry.quiet = this.quiet(entry, session, queue)
    entry.receive = acpReceiver(entry.start.config.harness.id, session, queue)
    const aborted = () => { entry.cancelled = true; void entry.peer.agent.cancel({ sessionId: session.binding.upstreamSessionId }) }
    broker.signal.addEventListener("abort", aborted, { once: true })
    const prompt = entry.peer.agent.prompt({ sessionId: session.binding.upstreamSessionId, prompt: acpPrompt(turn) })
    void prompt.then((result) => {
      for (const event of translateStopReason(result.stopReason, session.binding.sessionId)) queue.push({ event })
      queue.end()
    }, (error: unknown) => queue.fail(error))
    try {
      while (true) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      broker.signal.removeEventListener("abort", aborted)
      entry.receive = undefined
      entry.queue = undefined
      entry.turnBroker = undefined
      entry.quiet?.dispose()
      entry.quiet = undefined
      await entry.cancelSent
      entry.cancelSent = undefined
      if (entry.phase === "busy") entry.phase = "ready"
      if (entry.pendingRestart && entry.phase === "ready") await this.restart(entry)
    }
  }

  async cancel(session: HarnessSession, _turn: TurnRef, _deadline: Deadline) {
    const entry = this.entry(session)
    entry.cancelled = true
    await entry.peer.agent.cancel({ sessionId: session.binding.upstreamSessionId })
    return { execution: "unknown" as const, cleanup: "unknown" as const }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (entry.phase === "uncertain") {
      return { state: "refused", reason: "ACP session outcome is uncertain" }
    }
    const changed = Boolean(update.credentials && update.credentials.leaseGeneration !== entry.start.credentials.leaseGeneration)
      || Boolean(update.projection && update.projection.generation !== entry.start.projection.generation)
    if (!changed) return { state: "applied" }
    entry.start = { ...entry.start,
      ...(update.credentials ? { credentials: update.credentials } : {}),
      ...(update.projection ? { projection: update.projection } : {}) }
    if (entry.phase === "busy") { entry.pendingRestart = true; return { state: "deferred", until: "after-active-turns" } }
    await this.restart(entry)
    return { state: "applied" }
  }

  private async restart(entry: AcpEntry): Promise<void> {
    entry.pendingRestart = false
    entry.startupAbort.abort()
    await entry.peer.retire()
    const next = await this.open(entry.start, entry.broker)
    try {
      const upstreamSessionId = await restoreAcp(next.peer, { ...entry.start, binding: entry.session.binding },
        this.mcp(next).map(acpMcp), entry.broker, this.missingContext)
      entry.session.binding.upstreamSessionId = upstreamSessionId
      next.session = entry.session
      next.options = entry.options
      next.commands = entry.commands
      await entry.broker.rebind(upstreamSessionId)
      if (this.disposed) throw new AcpTransportError("connection", "ACP transport disposed during restart")
      this.starting.delete(next)
      this.startingAborts.delete(next.startupAbort)
      this.entries.set(entry.session.binding.sessionId, next)
    } catch (error) { this.starting.delete(next); this.startingAborts.delete(next.startupAbort); await next.peer.retire(); throw error }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    this.entries.delete(session.binding.sessionId)
    entry.startupAbort.abort()
    await entry.peer.retire()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.startingAborts) controller.abort()
    const entries = [...this.entries.values(), ...this.starting]
    for (const entry of entries) entry.startupAbort.abort()
    this.entries.clear()
    this.starting.clear()
    await Promise.all([...entries.map((entry) => entry.peer.retire()), this.probes.dispose()])
  }
}
