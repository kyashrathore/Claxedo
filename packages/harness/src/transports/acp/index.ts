import { acpPromptUsage, type AcpContextOccupancy } from "./usage"
import { translateStopReason } from "./translate/stop-reason"
import type { SessionNotification, SessionConfigOption, SessionMode } from "@agentclientprotocol/sdk"
import type {
  AttachInput, ConfigApplied, ConfigTarget, Deadline, HarnessServices, HarnessSession, HarnessTransport, McpServerSpec,
  ProjectedMcpServer, RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { acpDeclaredCapabilities, attachedSessionEntry, configGenerationChanged, mergeStartInput } from "../../contract"
import type { AcpConnectionOptions, AcpPeer } from "./connection"
import { AcpTransportError } from "./errors"
import { acpTurnFailure } from "./outcome"
import { AsyncPushQueue, errorMessage, type HoldableCountdown } from "@claxedo/helpers"
import { acpMcp, acpPrompt, type AcpPromptDelivery } from "./protocol"
import { claudeOptionsMeta } from "./extensions/claude-options"
import type { AcpStartupDeadline } from "./deadline"
import type { AcpProviderTurn } from "./provider-turn"
import { acpReceiver } from "./events"
import { acpConfig, acpHarnessConfig } from "./config"
import { supportsAcpSubagents } from "./extensions/subagents"
import { AcpDraftProbes } from "./probe"
import { AcpPeerOwnership } from "./ownership"
import { acpGroups } from "./extensions/groups"
import { acpGoalOperations } from "./extensions/goals"
import { acpSteerOperations } from "./extensions/steer"
import { acpAgentOperations } from "./extensions/agents"
import { AcpConnectionHealth } from "./health"
import { acpMcpProjection } from "./projection"
import { acpCancelDeadline, acpQuiet, trackedAcpCancel } from "./cancellation"
import { acpEffortCatalog, acpModelSelection } from "./options"
import { acpPrepareTurnConfig } from "./sync"
import { acpSessionTitle } from "./title"
import { attachAcpEntry, startAcpEntry, type AcpHost } from "./startup"
import { AcpSessionLifecycle } from "./lifecycle"

export type AcpMcpFilter = (input: {
  servers: readonly ProjectedMcpServer[]
  locality: "local" | "remote"
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean }
  supportsMcpServers?: boolean
}) => { servers: ProjectedMcpServer[]; notApplied: { item: string; reason: string }[] }

export type AcpEntry = {
  observation: ReturnType<AcpConnectionHealth["begin"]>
  session: HarnessSession
  start: StartInput
  broker: SessionBroker
  peer: AcpPeer
  onIdle(): void
  updatesDelivered(): Promise<void>
  providerTurn?: AcpProviderTurn
  queue?: AsyncPushQueue<RoutedEvent>
  receive?: (notification: SessionNotification) => void
  turnBroker?: TurnBroker
  phase: "ready" | "busy" | "uncertain"
  cancelled: boolean
  pendingRestart: boolean
  quiet?: HoldableCountdown
  startup?: AcpStartupDeadline
  startupAbort: AbortController
  pendingUpdates?: SessionNotification[]
  cancelSent?: Promise<{ ok: true } | { ok: false; error: unknown; running: boolean }>
  prompt?: Promise<unknown>
  commands: { name: string; description?: string }[]
  options: SessionConfigOption[]
  modes: SessionMode[]
  currentModeId?: string
  modeUpdates: number
  context?: AcpContextOccupancy
  sideSessions: Map<string, (update: SessionNotification["update"]) => void>
}

function sessionUncertain(entry: AcpEntry): boolean {
  return entry.phase === "uncertain"
}

export class AcpTransport implements HarnessTransport {
  readonly kind = "acp" as const
  private readonly entries = new Map<string, AcpEntry>()
  private readonly startingAborts = new Set<AbortController>()
  private readonly peers = new AcpPeerOwnership()
  private readonly lifecycle: AcpSessionLifecycle
  private readonly probes: AcpDraftProbes
  private readonly host: AcpHost
  private disposed = false
  readonly health: AcpConnectionHealth
  readonly commands = { list: async (target: ConfigTarget) => "session" in target
    ? this.entry(target.session).commands : this.probes.commands(target.draft) }
  readonly agents = acpAgentOperations((session) => this.entry(session), (draft) => this.probes.agents(draft))
  private readonly configOperations = acpConfig((session: HarnessSession) => this.entry(session), (draft, mode) => this.probes.catalog(draft, mode))
  readonly harnessConfig = acpHarnessConfig((session) => this.entry(session))
  private readonly goalOperations = acpGoalOperations((session) => this.entry(session))
  private readonly steerOperations = acpSteerOperations((session) => this.entry(session), (entry) => this.delivery(entry))
  private readonly forkOperations = { fork: async (session: HarnessSession, _messageId: string, childSessionId: string) => {
    const entry = this.entry(session)
    const result = await entry.peer.agent.unstable_forkSession({ sessionId: session.binding.upstreamSessionId,
      cwd: session.directory, mcpServers: this.mcp({ ...entry, start: { ...entry.start, sessionId: childSessionId } }).map(acpMcp) })
    return { upstreamSessionId: result.sessionId }
  } }
  readonly naming = { generateTitle: (session: HarnessSession, request: Parameters<typeof acpSessionTitle>[1]) => {
    const entry = this.entry(session)
    return acpSessionTitle(entry, request, { mcpServers: this.mcp(entry).map(acpMcp), meta: claudeOptionsMeta(entry.peer.handshake, entry.start).meta })
  } }
  get config() { return this.configOperations }
  get goals() { return [...this.entries.values()].some((entry) => acpGroups(entry.peer.handshake).goals.available) ? this.goalOperations : undefined }
  get steer() { return [...this.entries.values()].some((entry) => acpGroups(entry.peer.handshake).steer) ? this.steerOperations : undefined }
  get fork() { return [...this.entries.values()].some((entry) => entry.peer.handshake.agentCapabilities?.sessionCapabilities?.fork) ? this.forkOperations : undefined }

  constructor(private readonly services: HarnessServices, private readonly connection: AcpConnectionOptions,
    private readonly filterMcp: AcpMcpFilter) {
    this.health = new AcpConnectionHealth(services.clock, () => services.healthChanged())
    this.probes = new AcpDraftProbes(services, connection, filterMcp, this.peers)
    this.host = { services, health: this.health, connection, filterMcp, entries: this.entries,
      startingAborts: this.startingAborts, peers: this.peers, idle: (entry) => { if (entry.pendingRestart) this.lifecycle.defer(entry) },
      disposed: () => this.disposed, mcp: (entry) => this.mcp(entry) }
    this.lifecycle = new AcpSessionLifecycle(this.host)
  }

  async capabilities(context: { sessionId?: string; directory: string }): Promise<TransportCapabilities> {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : [...this.entries.values()].find((item) => item.session.directory === context.directory)
    const groups = entry ? acpGroups(entry.peer.handshake) : undefined
    return {
      modelSelection: acpModelSelection(entry), effortLevels: acpEffortCatalog(entry),
      instructionChannel: "prompt-prefix",
      ...acpDeclaredCapabilities,
      subagents: Boolean(entry && supportsAcpSubagents(entry.peer.handshake)),
      goals: groups?.goals ?? { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
    }
  }

  private entry(session: HarnessSession): AcpEntry {
    this.lifecycle.assertAvailable(session.binding.sessionId)
    return attachedSessionEntry(this.entries, session, () => new AcpTransportError("session", "ACP session is not attached"))
  }

  private mcp(entry: Pick<AcpEntry, "start" | "peer">): McpServerSpec[] {
    return acpMcpProjection(entry, this.services, this.connection, this.filterMcp).servers
  }

  private delivery(entry: AcpEntry): AcpPromptDelivery {
    return { capabilities: entry.peer.handshake.agentCapabilities?.promptCapabilities,
      ...(this.connection.sharedFilesystem ? { sharedDirectory: entry.session.directory } : {}) }
  }

  async restore(session: HarnessSession): Promise<HarnessSession> {
    const sessionId = session.binding.sessionId
    await this.lifecycle.settled(sessionId)
    const entry = this.entries.get(sessionId)
    if (entry?.phase === "ready" && entry.peer.agent.signal.aborted) {
      await this.lifecycle.restart(entry)
      await this.lifecycle.settled(sessionId)
    }
    const restored = this.entries.get(sessionId)
    return this.entry(restored?.session ?? session).session
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    await this.lifecycle.prepare(input.sessionId)
    return startAcpEntry(this.host, input, broker)
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    await this.lifecycle.prepare(input.sessionId)
    return attachAcpEntry(this.host, input, broker)
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    await this.lifecycle.settled(session.binding.sessionId)
    const entry = this.entry(session)
    if (entry.phase !== "ready" || entry.providerTurn) throw new AcpTransportError("session", entry.phase === "uncertain" ? "ACP session outcome is uncertain" : "ACP session already has an active turn")
    entry.phase = "busy"
    entry.cancelled = false
    entry.cancelSent = undefined
    entry.prompt = undefined
    entry.turnBroker = broker
    const queue = new AsyncPushQueue<RoutedEvent>()
    entry.queue = queue
    entry.receive = acpReceiver(entry.start.config.harness.id, session, queue)
    const aborted = () => { void trackedAcpCancel(entry, acpCancelDeadline()) }
    broker.signal.addEventListener("abort", aborted, { once: true })
    if (broker.signal.aborted) aborted()
    try {
      await acpPrepareTurnConfig(entry, turn, this.services.clock, this.connection.startupTimeoutMs)
      entry.quiet = acpQuiet(entry, queue, this.services.clock, this.connection.promptTimeoutMs ?? 300_000)
      yield* this.prompted(entry, session, turn, queue)
    } catch (error) {
      throw acpTurnFailure(error, { submitted: entry.prompt !== undefined, connectionAlive: !entry.peer.agent.signal.aborted, uncertain: sessionUncertain(entry) })
    } finally {
      broker.signal.removeEventListener("abort", aborted)
      entry.receive = undefined
      entry.queue = undefined
      entry.turnBroker = undefined
      entry.quiet?.dispose()
      entry.quiet = undefined
      await (entry.cancelSent ?? Promise.resolve(undefined))
      entry.cancelSent = undefined
      if (entry.phase === "busy") entry.phase = "ready"
      if (entry.pendingRestart && entry.phase === "ready") this.lifecycle.defer(entry)
    }
  }

  private async *prompted(entry: AcpEntry, session: HarnessSession, turn: TurnInput, queue: AsyncPushQueue<RoutedEvent>): AsyncIterable<RoutedEvent> {
    const content = await acpPrompt(turn, this.delivery(entry))
    if (entry.cancelled) {
      for (const event of translateStopReason("cancelled", session.binding.sessionId)) yield { event }
      return
    }
    const prompt = entry.peer.agent.prompt({ sessionId: session.binding.upstreamSessionId, prompt: content })
    entry.prompt = prompt
    void prompt.then((result) => entry.updatesDelivered().then(() => result)).then((result) => {
      for (const event of acpPromptUsage(result, session.binding.upstreamSessionId, entry.context)) queue.push(event)
      for (const event of translateStopReason(result.stopReason, session.binding.sessionId)) queue.push({ event })
      queue.end()
    }, (error: unknown) => queue.fail(error))
    yield* queue
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (entry.phase === "ready" && !entry.providerTurn) return { execution: "terminal" as const, cleanup: "unknown" as const }
    if (entry.phase === "uncertain") return { execution: "unknown" as const, cleanup: "unknown" as const }
    const result = await trackedAcpCancel(entry, deadline)
    if (!result.ok) return { execution: result.running ? "running" as const : "unknown" as const, cleanup: "unknown" as const,
      error: { code: result.running ? "cancellation_timeout" as const : "provider_unreachable" as const, message: errorMessage(result.error) } }
    return { execution: entry.prompt ? "terminal" as const : "unknown" as const, cleanup: "unknown" as const }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    await this.lifecycle.settled(session.binding.sessionId)
    const entry = this.entry(session)
    if (entry.phase === "uncertain") {
      return { state: "refused", reason: "ACP session outcome is uncertain" }
    }
    const next = mergeStartInput(entry.start, update)
    const changed = configGenerationChanged(entry.start, next)
    if (!changed) return { state: "applied" }
    entry.start = next
    if (entry.phase === "busy" || entry.providerTurn) { entry.pendingRestart = true; return { state: "deferred", until: "after-active-turns" } }
    await this.lifecycle.restart(entry)
    return { state: "applied" }
  }

  close(session: HarnessSession): Promise<void> {
    return this.lifecycle.close(session)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.startingAborts) controller.abort()
    this.probes.dispose()
    try { await this.lifecycle.dispose() } finally { this.health.clear() }
    await this.peers.retireAll()
  }
}
