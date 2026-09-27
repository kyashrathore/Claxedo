import { translateStopReason } from "./translate/translate-session-update"
import type { SessionNotification, SessionConfigOption, SessionMode } from "@agentclientprotocol/sdk"
import type {
  AttachInput, ConfigApplied, ConfigTarget, Deadline, HarnessServices, HarnessSession, HarnessTransport, McpServerSpec,
  ProjectedMcpServer, RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, configGenerationChanged, mergeStartInput } from "../../contract"
import type { AcpConnectionOptions, AcpPeer } from "./connection"
import { AcpTransportError } from "./errors"
import { acpTurnFailure } from "./outcome"
import { AsyncPushQueue, errorMessage } from "@claxedo/helpers"
import { acpMcp, acpPrompt, type AcpPromptDelivery } from "./protocol"
import type { MissingSessionContext } from "./restore"
import { claudeOptionsMeta } from "./extensions/claude-options"
import type { AcpStartupDeadline } from "./deadline"
import type { AcpQuiet } from "./quiet"
import { acpReceiver } from "./events"
import { acpConfig } from "./config"
import { supportsAcpSubagents } from "./extensions/subagents"
import { AcpDraftProbes } from "./probe"
import { acpGroups } from "./extensions/groups"
import { acpGoalOperations } from "./extensions/goals"
import { acpSteerOperations } from "./extensions/steer"
import { acpAgentOperations } from "./extensions/agents"
import { acpHealthOperations } from "./extensions/health"
import { acpMcpServers } from "./projection"
import { acpCancelDeadline, acpQuiet, trackedAcpCancel } from "./cancellation"
import { acpEffortCatalog, acpModelSelection } from "./options"
import { acpApplyTurnConfig } from "./sync"
import { acpSessionTitle } from "./title"
import { attachAcpEntry, restartAcpEntry, startAcpEntry, type AcpHost } from "./startup"

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
  queue?: AsyncPushQueue<RoutedEvent>
  receive?: (notification: SessionNotification) => void
  turnBroker?: TurnBroker
  phase: "ready" | "busy" | "uncertain"
  cancelled: boolean
  pendingRestart: boolean
  quiet?: AcpQuiet
  startup?: AcpStartupDeadline
  startupAbort: AbortController
  pendingUpdates?: SessionNotification[]
  cancelSent?: Promise<{ ok: true } | { ok: false; error: unknown }>
  commands: { name: string; description?: string }[]
  options: SessionConfigOption[]
  modes: SessionMode[]
  currentModeId?: string
  modeUpdates: number
  sideSessions: Map<string, (update: SessionNotification["update"]) => void>
}

function sessionUncertain(entry: AcpEntry): boolean {
  return entry.phase === "uncertain"
}

export class AcpTransport implements HarnessTransport {
  readonly kind = "acp" as const
  private readonly entries = new Map<string, AcpEntry>()
  private readonly starting = new Set<AcpEntry>()
  private readonly startingAborts = new Set<AbortController>()
  private readonly restarts = new Map<string, Promise<void>>()
  private readonly restartFailures = new Map<string, unknown>()
  private readonly probes: AcpDraftProbes
  private readonly host: AcpHost
  private disposed = false
  private readonly healthOperations = acpHealthOperations((sessionId) => this.entries.get(sessionId)?.peer.agent.signal.aborted === false)
  private readonly commandOperations = { list: async (target: ConfigTarget) => "session" in target
    ? this.entry(target.session).commands : this.probes.commands(target.draft) }
  private readonly agentOperations = acpAgentOperations((session) => this.entry(session), (draft) => this.probes.agents(draft))
  private readonly configOperations = acpConfig((session: HarnessSession) => this.entry(session), (draft, mode) => this.probes.catalog(draft, mode))
  private readonly goalOperations = acpGoalOperations((session) => this.entry(session))
  private readonly steerOperations = acpSteerOperations((session) => this.entry(session), (entry) => this.delivery(entry))
  private readonly forkOperations = { fork: async (session: HarnessSession, _messageId: string) => {
    const entry = this.entry(session)
    const result = await entry.peer.agent.unstable_forkSession({ sessionId: session.binding.upstreamSessionId,
      cwd: session.directory, mcpServers: this.mcp(entry).map(acpMcp) })
    return { upstreamSessionId: result.sessionId }
  } }
  readonly naming = { generateTitle: (session: HarnessSession, request: Parameters<typeof acpSessionTitle>[1]) => {
    const entry = this.entry(session)
    return acpSessionTitle(entry, request, { mcpServers: this.mcp(entry).map(acpMcp), meta: claudeOptionsMeta(entry.peer.handshake, entry.start).meta })
  } }
  get commands() { return this.commandOperations }
  get agents() { return this.agentOperations }
  get config() { return this.configOperations }
  get goals() { return [...this.entries.values()].some((entry) => acpGroups(entry.peer.handshake).goals.available) ? this.goalOperations : undefined }
  get steer() { return [...this.entries.values()].some((entry) => acpGroups(entry.peer.handshake).steer) ? this.steerOperations : undefined }
  get health() { return [...this.entries.values()].some((entry) => acpGroups(entry.peer.handshake).health) ? this.healthOperations : undefined }
  get fork() { return [...this.entries.values()].some((entry) => entry.peer.handshake.agentCapabilities?.sessionCapabilities?.fork) ? this.forkOperations : undefined }

  constructor(private readonly services: HarnessServices, private readonly connection: AcpConnectionOptions,
    private readonly filterMcp: AcpMcpFilter, private readonly missingContext: MissingSessionContext) {
    this.probes = new AcpDraftProbes(services, connection, filterMcp)
    this.host = { services, connection, filterMcp, missingContext, entries: this.entries, starting: this.starting,
      startingAborts: this.startingAborts, disposed: () => this.disposed, mcp: (entry) => this.mcp(entry) }
  }

  async capabilities(context: { sessionId?: string; directory: string }): Promise<TransportCapabilities> {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : [...this.entries.values()].find((item) => item.session.directory === context.directory)
    const declared = entry?.peer.handshake.agentCapabilities
    const mcp = declared?.mcpCapabilities
    const groups = entry ? acpGroups(entry.peer.handshake) : undefined
    return {
      modelSelection: acpModelSelection(entry), effortLevels: acpEffortCatalog(entry),
      instructionChannel: "prompt-prefix", configOwner: "harness",
      requests: { permissions: true, questions: false, elicitation: true },
      subagents: Boolean(entry && supportsAcpSubagents(entry.peer.handshake)),
      goals: groups?.goals ?? { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
      todos: false,
      history: "store", titles: "side-request", pluginIntake: { mcp: this.connection.supportsMcpServers === false ? "none" : "session", skills: "none" },
      mcpTransports: { stdio: this.connection.kind === "process" && this.connection.supportsMcpServers !== false,
        http: this.connection.supportsMcpServers !== false && mcp?.http === true,
        sse: this.connection.supportsMcpServers !== false && mcp?.sse === true },
      timing: { model: "immediate", effort: "immediate", permissionMode: "immediate", credentials: "after-active-turns" },
    }
  }

  private entry(session: HarnessSession): AcpEntry {
    const failed = this.restartFailures.get(session.binding.sessionId)
    if (failed !== undefined) throw new AcpTransportError("session", `ACP session restart failed: ${errorMessage(failed)}`, failed)
    return attachedSessionEntry(this.entries, session, () => new AcpTransportError("session", "ACP session is not attached"))
  }

  private mcp(entry: Pick<AcpEntry, "start" | "peer">): McpServerSpec[] {
    return acpMcpServers(entry, this.services, this.connection, this.filterMcp)
  }

  private delivery(entry: AcpEntry): AcpPromptDelivery {
    return { capabilities: entry.peer.handshake.agentCapabilities?.promptCapabilities,
      ...(this.connection.sharedFilesystem ? { sharedDirectory: entry.session.directory } : {}) }
  }

  private async settled(sessionId: string): Promise<void> {
    await this.restarts.get(sessionId)
  }

  private async revived(sessionId: string): Promise<void> {
    await this.settled(sessionId)
    const entry = this.entries.get(sessionId)
    if (entry?.phase !== "ready" || !entry.peer.agent.signal.aborted) return
    this.deferRestart(entry)
    await this.settled(sessionId)
  }

  start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    this.restartFailures.delete(input.sessionId)
    return startAcpEntry(this.host, input, broker)
  }

  attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    this.restartFailures.delete(input.sessionId)
    return attachAcpEntry(this.host, input, broker)
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    await this.revived(session.binding.sessionId)
    const entry = this.entry(session)
    if (entry.phase !== "ready") throw new AcpTransportError("session", entry.phase === "uncertain" ? "ACP session outcome is uncertain" : "ACP session already has an active turn")
    entry.phase = "busy"
    entry.cancelled = false
    entry.cancelSent = undefined
    entry.turnBroker = broker
    const queue = new AsyncPushQueue<RoutedEvent>()
    entry.queue = queue
    entry.quiet = acpQuiet(entry, queue, this.services.clock, this.connection.promptTimeoutMs ?? 300_000)
    entry.receive = acpReceiver(entry.start.config.harness.id, session, queue)
    const aborted = () => { void trackedAcpCancel(entry, acpCancelDeadline()) }
    broker.signal.addEventListener("abort", aborted, { once: true })
    const submission = { submitted: false }
    try {
      yield* this.prompted(entry, session, turn, queue, submission)
    } catch (error) {
      throw acpTurnFailure(error, { submitted: submission.submitted, connectionAlive: !entry.peer.agent.signal.aborted, uncertain: sessionUncertain(entry) })
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
      if (entry.pendingRestart && entry.phase === "ready") this.deferRestart(entry)
    }
  }

  private async *prompted(entry: AcpEntry, session: HarnessSession, turn: TurnInput, queue: AsyncPushQueue<RoutedEvent>,
    submission: { submitted: boolean }): AsyncIterable<RoutedEvent> {
    await acpApplyTurnConfig(entry, turn)
    const prompt = entry.peer.agent.prompt({ sessionId: session.binding.upstreamSessionId, prompt: await acpPrompt(turn, this.delivery(entry)) })
    submission.submitted = true
    void prompt.then((result) => {
      for (const event of translateStopReason(result.stopReason, session.binding.sessionId)) queue.push({ event })
      queue.end()
    }, (error: unknown) => queue.fail(error))
    while (true) {
      const next = await queue.next()
      if (next.done) return
      yield next.value
    }
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (entry.phase === "ready") return { execution: "terminal" as const, cleanup: "unknown" as const }
    if (entry.phase === "uncertain") return { execution: "unknown" as const, cleanup: "unknown" as const }
    const result = await trackedAcpCancel(entry, deadline)
    if (!result.ok) return { execution: "unknown" as const, cleanup: "unknown" as const,
      error: { code: "provider_unreachable" as const, message: errorMessage(result.error) } }
    return { execution: "unknown" as const, cleanup: "unknown" as const }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    await this.settled(session.binding.sessionId)
    const entry = this.entry(session)
    if (entry.phase === "uncertain") {
      return { state: "refused", reason: "ACP session outcome is uncertain" }
    }
    const next = mergeStartInput(entry.start, update)
    const changed = configGenerationChanged(entry.start, next)
    if (!changed) return { state: "applied" }
    entry.start = next
    if (entry.phase === "busy") { entry.pendingRestart = true; return { state: "deferred", until: "after-active-turns" } }
    await restartAcpEntry(this.host, entry)
    return { state: "applied" }
  }

  private deferRestart(entry: AcpEntry): void {
    const id = entry.session.binding.sessionId
    const restarting = restartAcpEntry(this.host, entry).then(() => { this.restarts.delete(id) }, (error: unknown) => {
      this.restarts.delete(id)
      this.restartFailures.set(id, error)
      entry.broker.reportFailure(error)
    })
    this.restarts.set(id, restarting)
  }

  async close(session: HarnessSession): Promise<void> {
    await this.settled(session.binding.sessionId)
    this.restartFailures.delete(session.binding.sessionId)
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
    this.restartFailures.clear()
    await Promise.all([...entries.map((entry) => entry.peer.retire()), this.probes.dispose(), ...this.restarts.values()])
  }
}
