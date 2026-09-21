import { asRecord, type AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { randomUUID } from "crypto"
import type { ACPConnectionObservationUpdate } from "./connection-state"
import {
  client,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ClientConnection,
  type ClientCapabilities,
  type ClientContext,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type PermissionOption,
  type ToolKind,
  type RequestPermissionResponse,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
  type Usage,
} from "@agentclientprotocol/sdk"
import type { PromptInput } from "../../index"
import { Log } from "../../log"
import {
  ACP_GOAL_METHODS,
  blocks,
  extractAgents,
  init,
  merge,
  permissionModes,
  resolvedModel,
  resume,
  setPermissionMode,
  sync,
  goalExtension,
  goalExtensionCapabilities,
  type ACPState,
  type ACPGoalExtension,
} from "./session"
import type { AgentPermissionModeState, ResolvedHarnessModel } from "../../adapter-contract"
import type { GoalCapabilities } from "../../capabilities"
import { type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { IDLE_TIMEOUT_MS, newSessionTimeoutMs, initializeTimeoutMs, promptTimeoutMs, watch } from "./helpers"
import { AcpSessionUncertainError } from "./recovery"
import { normalizeACPGoal } from "./goal-response"
import { createStartupRequestLease } from "./startup-request"
import { ACP_SUBAGENT_CLIENT_CAPABILITIES, acpRootSessionId, receiveACPSubagentNotification, supportsACPSubagents, type ACPSubagentNotification } from "./subagents"
import { createIdleReaper, type IdleReaper } from "../shared/process-lifecycle"
import type { RetirementResult } from "../../launch"
import { createACPExitGate, type ACPExitGate } from "./process-retirement"
import type { ACPTransport, ACPTransportEnv, ACPTransportFactory } from "./transport"
import type { AgentProcessObserverHandle } from "../../process-observer"

const log = Log.create({ service: "acp-adapter" })

export type SessionUpdate = SessionNotification["update"]

export function acpClientCapabilities(): ClientCapabilities & { subagents: Record<string, never> } {
  return {
    ...ACP_SUBAGENT_CLIENT_CAPABILITIES,
    auth: { terminal: false },
    fs: { readTextFile: true, writeTextFile: true },
    plan: {},
    terminal: true,
    elicitation: { form: {}, url: {} },
  }
}
/**
 * `tool` is the agent's human-readable `toolCall.title` ("Read file src/index.ts");
 * `kind` is the protocol's machine-readable `ToolKind` classification. Both are
 * strings, so the named payload keeps their meanings explicit.
 */
export type PermissionPushPayload = {
  permId: string
  /** The agent's `toolCall.title`; absent when the agent sent none. */
  tool?: string
  kind?: ToolKind
  paths: string[]
  toolCall?: RequestPermissionRequest["toolCall"]
  requestMeta?: RequestPermissionRequest["_meta"]
}

export type PermissionPusher = (payload: PermissionPushPayload) => void

export interface PendingPermission {
  aid: string
  tool?: string
  /** Protocol classification; absent when the agent does not send one. */
  kind?: ToolKind
  paths: string[]
  toolCall?: RequestPermissionRequest["toolCall"]
  requestMeta?: RequestPermissionRequest["_meta"]
  options: PermissionOption[]
  resolve: (response: RequestPermissionResponse) => void
}

// ── Shared ACP process ───────────────────────────────────────────────────────

export class ACPProcess {
  elicitationHandler?: (params: CreateElicitationRequest, owner: string | AgentSessionStartBinding, signal: AbortSignal) => Promise<CreateElicitationResponse>
  elicitationComplete?: (elicitationId: string) => void
  elicitationCancel?: (agentSessionId: string) => void
  private readonly outboundSessionRequests = new Map<string | number, string | { start: AgentSessionStartBinding; quiet: IdleReaper; controller: AbortController }>()
  private readonly startingRequests = new WeakMap<object, { start: AgentSessionStartBinding; quiet: IdleReaper; controller: AbortController }>()
  private transport!: ACPTransport
  readonly connection: ClientConnection
  readonly agent: ClientContext
  private readonly idle: IdleReaper
  private caps: InitializeResponse["agentCapabilities"] | null = null
  private goal: ACPGoalExtension | null = null
  private nativeSubagents = false
  private readonly childParents = new Map<string, string>()
  private readonly subagentDisconnects = new Map<string, () => Promise<void>>()
  private readonly subagentListeners = new Map<string, (notification: ACPSubagentNotification) => Promise<void>>()
  readonly pendingPermissions = new Map<string, PendingPermission>()
  // agentSessionId → the running prompt's quiet countdown
  private readonly promptQuiet = new Map<string, IdleReaper>()
  // agentSessionId → update listener
  readonly sessionListeners = new Map<string, (update: SessionUpdate) => void>()
  // agentSessionId → lifecycle observer retained between prompts
  readonly sessionObservers = new Map<string, (update: SessionUpdate) => void>()
  readonly goalListeners = new Map<string, (goal: RuntimeGoalSnapshot | null) => void>()
  readonly goalUpdateListeners = new Map<string, (update: SessionUpdate) => void>()
  private states = new Map<string, ACPState>()
  private readonly loadedSessions = new Set<string>()
  private restorations = new Map<string, Promise<void>>()
  private readonly commandUpdates = new Map<string, SessionUpdate>()
  private readonly commandListeners = new Map<string, (update: SessionUpdate) => void>()
  // agentSessionId → permission pusher
  readonly permissionPushers = new Map<string, PermissionPusher>()
  /** Cached config options from newSession() response or config_option_update notifications */
  cachedConfigOptions: SessionConfigOption[] | null = null
  /** The model this agent last reported as current, cached alongside the options. */
  cachedResolvedModel: ResolvedHarnessModel | null = null
  // A prompt owns one agent session; unrelated sessions may run concurrently.
  private readonly activePrompts = new Set<string>()
  private readonly promptSettlements = new Map<string, Promise<void>>()
  private readonly uncertainSessions = new Map<string, Promise<unknown>>()
  private uncertaintyListeners = new Map<string, (error: AcpSessionUncertainError) => void>()
  private uncertaintyReported = new Set<string>()
  private lastStderr = ""
  private constructed = false
  private pendingDeath = false
  private deadNotified = false
  private disposed = false
  private readonly exit: ACPExitGate
  private observation: AgentProcessObserverHandle | undefined
  private observationExited = false
  private observationExit: { reason: "exited" | "error" | "disposed"; exitCode?: number } | undefined

  constructor(
    readonly directory: string,
    command: string | undefined,
    args: string[],
    model: string,
    /** The Claxedo session id, when known, selects that session's first-party server entry. */
    private readonly mcp: (sessionId?: string) => McpServer[],
    private readonly onDead: () => void,
    createTransport: ACPTransportFactory,
    private readonly env: () => ACPTransportEnv,
    observe?: (input: {
      pid?: number
      kind: ACPTransport["kind"]
    }) => AgentProcessObserverHandle,
    private readonly connectionObservation?: (update: ACPConnectionObservationUpdate) => void,
  ) {
    this.idle = createIdleReaper({
      idleMs: IDLE_TIMEOUT_MS,
      onIdle: () => {
        log.info("ACP process idle timeout, disposing", { directory: this.directory, idleMs: IDLE_TIMEOUT_MS })
        this.dispose()
      },
    })
    this.exit = createACPExitGate({
      transport: { dispose: () => this.transport.dispose() },
      stderr: () => this.lastStderr,
    })
    this.transport = createTransport({
      directory,
      command,
      args,
      model,
      env: this.env(),
      onStderr: (text) => {
        // Promoted to info so binary errors are always visible.
        this.lastStderr = text
        log.info("ACP stderr", { text })
      },
      onExit: (code, signal) => {
        log.info("ACP transport exited", { code, signal, directory, kind: this.transport?.kind })
        this.exitObservation({ reason: "exited", ...(code !== null ? { exitCode: code } : {}) })
        this.exit.fail(new Error(this.exit.exitMessage(code, signal)))
        this.notifyDead()
      },
      onError: (err) => {
        log.error("ACP transport error", { err, command, directory, kind: this.transport?.kind })
        this.exitObservation({ reason: "error" })
        this.exit.fail(err)
        this.notifyDead()
      },
    })
    this.observation = observe?.({
      ...(this.transport.pid ? { pid: this.transport.pid } : {}),
      kind: this.transport.kind,
    })
    if (this.observationExit) this.observation?.exit(this.observationExit)
    log.info("ACP transport created", this.transport.metadata)
    const writer = this.transport.stream.writable.getWriter()

    this.connection = client({ name: "claxedo-workspace-runtime" })
      .onRequest(methods.client.elicitation.create, async ({ params, signal, requestId }) => {
        const scope = asRecord(params)
        const session = typeof scope?.sessionId === "string" ? scope.sessionId
          : typeof scope?.requestId === "string" || typeof scope?.requestId === "number" ? this.outboundSessionRequests.get(scope.requestId) : undefined
        if (!session) throw RequestError.invalidParams(undefined, "Elicitation has no active session owner")
        if (!this.elicitationHandler) throw RequestError.invalidParams(undefined, "Elicitation has no active session owner")
        const idle = this.leaseIdle()
        const waiting = typeof session === "string" ? this.promptQuiet.get(this.rootAgentSessionId(session))?.lease() : session.quiet.lease()
        try { return await this.elicitationHandler(params, typeof session === "string" ? session : session.start, typeof session === "string" ? signal : AbortSignal.any([signal, session.controller.signal])) }
        catch (error) { throw RequestError.invalidParams(undefined, error instanceof Error ? error.message : String(error)) }
        finally { waiting?.release(); idle.release() }
      })
      .onNotification(methods.client.elicitation.complete, ({ params }) => { this.elicitationComplete?.(params.elicitationId) })
      .onNotification(methods.client.session.update, async ({ params }) => {
        const kind = params.update?.sessionUpdate ?? "(unknown)"
        if (kind === "available_commands_update") {
          this.commandUpdates.set(params.sessionId, params.update)
          const commands = this.commandListeners.get(params.sessionId)
          if (commands) {
            this.promptQuiet.get(params.sessionId)?.touch()
            commands(params.update)
            return
          }
        }
        log.info("ACP sessionUpdate received", {
          sessionId: params.sessionId,
          kind,
          hasListener: this.sessionListeners.has(params.sessionId),
        })
        // Both mode channels fold back into ACPState here, BEFORE the listener
        // check — an agent can change its own mode with no per-session listener
        // registered, and dropping that leaves the cached state asserting a mode
        // the agent has already left.
        if (params.update?.sessionUpdate === "config_option_update") {
          const opts = (params.update as { configOptions: SessionConfigOption[] }).configOptions
          this.remember(params.sessionId, { configOptions: opts })
          log.info("ACP sessionUpdate: cached config options", { count: opts.length })
        }
        /*
         * `session/set_mode` has no response state. Mode notifications synchronize
         * the requested value with the agent when plan exit or model changes alter
         * the available mode set. Agents using config options are handled above;
         * agents advertising `availableModes` publish `current_mode_update`.
         */
        if (params.update?.sessionUpdate === "current_mode_update") {
          const currentModeId = (params.update as { currentModeId?: string }).currentModeId
          if (currentModeId) {
            // Shaped as a `modes` payload because `merge` reads `currentModeId`
            // from that field; `availableModes` is carried through unchanged so
            // the advertised list is not dropped by the update.
            const state = this.state(params.sessionId)
            this.remember(params.sessionId, {
              modes: { availableModes: state.modes, currentModeId },
            })
            log.info("ACP sessionUpdate: agent changed mode", { sessionId: params.sessionId, currentModeId })
          }
        }
        const updateMeta = asRecord(asRecord(params.update)?._meta)
        if (updateMeta && "goal" in updateMeta) {
          this.goalListeners.get(params.sessionId)?.(normalizeACPGoal(updateMeta.goal, params.sessionId, this.goal))
        }
        const listener = this.sessionListeners.get(params.sessionId)
        const observer = this.sessionObservers.get(params.sessionId)
        const goalListener = this.goalUpdateListeners.get(params.sessionId)
        if (!listener && !observer && !goalListener) {
          log.info("ACP sessionUpdate: no listener registered, dropping update", {
            sessionId: params.sessionId,
            kind,
          })
          return
        }
        // The prompt listener owns every update while a turn is active. The
        // observer and the Goal listener are continuations for updates that
        // arrive outside a prompt — the observer for lifecycle notifications
        // that land after the prompt response removed that listener, the Goal
        // listener for iterations the agent drives on its own. Invoking more
        // than one would project the same canonical frame twice.
        if (listener) listener(params.update)
        else if (observer) observer(params.update)
        else goalListener?.(params.update)
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        const permId = randomUUID()
        const toolCall = params.toolCall
        const tool = toolCall.title ?? undefined
        // `title` is prose for display; `kind` is the stable classification used
        // by permission policy.
        // ACP types this as `ToolKind | null | undefined`; collapse the null so
        // downstream only has to handle "absent".
        const kind = toolCall.kind ?? undefined
        const paths = (toolCall.locations ?? []).map((location) => location.path)
        const hasListener = this.sessionListeners.has(params.sessionId)

        log.info("ACP requestPermission received", {
          sessionId: params.sessionId,
          tool,
          kind,
          permId,
          optionKinds: params.options.map((o) => o.kind),
          hasListener,
        })

        // A permission waits on the human, not the agent, so the prompt's quiet
        // countdown holds until the answer arrives.
        const waiting = this.promptQuiet.get(this.rootAgentSessionId(params.sessionId))?.lease()
        return new Promise<RequestPermissionResponse>((resolve) => {
          this.pendingPermissions.set(permId, {
            aid: params.sessionId,
            tool,
            kind,
            paths,
            toolCall,
            requestMeta: params._meta,
            options: params.options,
            resolve: (response) => {
              waiting?.release()
              resolve(response)
            },
          })

          // Push permission-request directly via the registered pusher (no synthetic injection)
          const pusher = this.permissionPushers.get(params.sessionId) ?? this.permissionPushers.get(this.rootAgentSessionId(params.sessionId))
          if (pusher) {
            log.info("ACP requestPermission: pushing permission-request to stream", {
              permId,
              tool,
            })
            pusher({ permId, tool, kind, paths, toolCall, requestMeta: params._meta })
          } else {
            log.info(
              "ACP requestPermission: no active pusher — permission stored but not forwarded to frontend yet",
              { permId, tool, kind, sessionId: params.sessionId },
            )
          }
        })
      })
      .connect({
        writable: new WritableStream({
          write: (message) => {
            if ("method" in message && "id" in message) {
              const params = asRecord(message.params)
              if (message.id !== null && typeof params?.sessionId === "string") this.outboundSessionRequests.set(message.id, params.sessionId)
              const start = params && this.startingRequests.get(params)
              if (message.id !== null && start) this.outboundSessionRequests.set(message.id, start)
            }
            return writer.write(message)
          },
          close: () => writer.close(),
          abort: (reason) => writer.abort(reason),
        }),
        // The released SDK rejects draft subagent updates before application
        // handlers. This narrow negotiated boundary consumes those exact frames.
        readable: this.transport.stream.readable.pipeThrough(new TransformStream({
          transform: async (message, controller) => {
            if ("error" in message && message.error?.code === -32000) this.connectionObservation?.({ state: "auth-required", reason: "authentication_required" })
            if (!("method" in message) && "id" in message && message.id !== null) this.outboundSessionRequests.delete(message.id)
            if (!await this.receiveSubagentNotification(message)) controller.enqueue(message)
          },
        })),
      })

    this.agent = this.connection.agent
    void this.connection.closed.then(() => {
      this.exit.fail(new Error(this.exit.connectionClosedMessage()))
      this.notifyDead()
    })
    this.constructed = true
    if (this.pendingDeath) queueMicrotask(() => this.notifyDead())
    this.resetIdleTimer()
  }

  private resetIdleTimer() {
    this.idle.touch()
  }

  /** Holds the process open while a prompt may be quiet inside a tool call. */
  private leaseIdle() {
    return this.idle.lease()
  }

  private notifyDead() {
    if (this.deadNotified) return
    if (!this.constructed) { this.pendingDeath = true; return }
    this.deadNotified = true
    this.connectionObservation?.({ state: "disconnected", reason: "transport_closed" })
    // A closed protocol stream may leave the wrapper and its writers alive.
    // Register retirement before allowing the manager to replace this owner.
    void this.exit.retire()
    for (const disconnect of this.subagentDisconnects.values()) void disconnect().catch((error) => log.error("ACP child disconnect settlement failed", { error }))
    this.subagentDisconnects.clear()
    this.subagentListeners.clear()
    if (!this.disposed) this.onDead()
  }

  async initialize(owner?: AgentSessionStartBinding, signal?: AbortSignal): Promise<void> {
    this.resetIdleTimer()
    const t0 = Date.now()
    log.info("ACP initialize: starting handshake", { directory: this.directory })
    const params = { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "claxedo-workspace-runtime", version: "0.1.0" }, clientCapabilities: acpClientCapabilities() }
    const lease = createStartupRequestLease(owner ? initializeTimeoutMs() : undefined, this.leaseIdle(), "initialize", signal)
    if (owner) this.startingRequests.set(params, { start: owner, quiet: lease.quiet!, controller: lease.controller })
    let result: InitializeResponse
    try {
      result = await lease.wait(Promise.race([
        this.agent.request(methods.agent.initialize, params, { cancellationSignal: lease.controller.signal }) as Promise<InitializeResponse>, this.exit.waitForExit(),
      ]))
    } finally { lease.release(); this.startingRequests.delete(params) }
    this.caps = result.agentCapabilities ?? null
    this.goal = goalExtension(result._meta)
    this.nativeSubagents = supportsACPSubagents(result)
    this.observation?.update({ lifecycle: "ready" })
    this.connectionObservation?.({ state: "ready" })
    log.info("ACP initialize: handshake complete", { directory: this.directory, ms: Date.now() - t0 })
  }

  supportsSubagents() { return this.nativeSubagents }

  rootAgentSessionId(agentSessionId: string): string {
    return acpRootSessionId(this.childParents, agentSessionId)
  }

  listenSubagents(agentSessionId: string, listener: (notification: ACPSubagentNotification) => Promise<void>, disconnect?: () => Promise<void>) {
    if (disconnect) this.subagentDisconnects.set(agentSessionId, disconnect)
    this.subagentListeners.set(agentSessionId, listener)
    return () => {
      if (this.subagentListeners.get(agentSessionId) === listener) {
        this.subagentListeners.delete(agentSessionId)
        this.subagentDisconnects.delete(agentSessionId)
      }
    }
  }

  private receiveSubagentNotification(message: unknown): Promise<boolean> {
    return receiveACPSubagentNotification(message, { enabled: this.nativeSubagents, parents: this.childParents,
      rootSessionId: (id) => this.rootAgentSessionId(id), touch: (id) => this.promptQuiet.get(id)?.touch(),
      listeners: this.subagentListeners, diagnose: (message, detail) => log.info(message, detail) })
  }

  failureDetail() {
    return this.lastStderr
  }

  goalCapabilities(): GoalCapabilities {
    return goalExtensionCapabilities(this.goal)
  }

  private async goalRequest(
    method: string,
    agentSessionId: string,
    localSessionId: string,
    input?: Record<string, unknown>,
  ): Promise<RuntimeGoalSnapshot | null> {
    if (!this.goal?.methods.has(method)) throw new Error(`ACP Goal method ${method} was not negotiated`)
    const response = await this.agent.request<unknown, Record<string, unknown>>(method, {
      sessionId: agentSessionId,
      ...input,
    })
    return normalizeACPGoal(response, localSessionId, this.goal)
  }

  readGoal(agentSessionId: string, localSessionId: string) {
    return this.goalRequest(ACP_GOAL_METHODS.read, agentSessionId, localSessionId)
  }

  startGoal(agentSessionId: string, localSessionId: string, objective: string) {
    return this.goalRequest(ACP_GOAL_METHODS.start, agentSessionId, localSessionId, { objective })
  }

  stopGoal(agentSessionId: string, localSessionId: string) {
    return this.goalRequest(ACP_GOAL_METHODS.stop, agentSessionId, localSessionId)
  }

  goalAction(action: "pause" | "resume" | "delete", agentSessionId: string, localSessionId: string) {
    if (!this.goal?.actions.includes(action)) throw new Error(`ACP Goal action ${action} was not negotiated`)
    return this.goalRequest(ACP_GOAL_METHODS[action], agentSessionId, localSessionId)
  }

  listenGoal(agentSessionId: string, localSessionId: string, listener: (goal: RuntimeGoalSnapshot | null) => void) {
    this.goalListeners.set(agentSessionId, (goal) => listener(goal ? { ...goal, sessionId: localSessionId } : null))
    return () => this.goalListeners.delete(agentSessionId)
  }

  listenGoalUpdates(agentSessionId: string, listener: (update: SessionUpdate) => void) {
    this.goalUpdateListeners.set(agentSessionId, listener)
  }

  unlistenGoal(agentSessionId: string) {
    this.goalListeners.delete(agentSessionId)
    this.goalUpdateListeners.delete(agentSessionId)
  }

  private state(sessionId: string) {
    return this.states.get(sessionId) ?? init(this.caps)
  }

  hasSession(sessionId: string) {
    return this.loadedSessions.has(sessionId)
  }

  assertSessionReady(sessionId: string) {
    if (this.uncertainSessions.has(sessionId)) throw new AcpSessionUncertainError(sessionId)
  }

  quarantineSession(sessionId: string, pending: Promise<unknown>) {
    this.uncertainSessions.set(sessionId, pending)
    const clear = () => {
      if (this.uncertainSessions.get(sessionId) === pending) this.uncertainSessions.delete(sessionId)
    }
    void pending.then(clear, clear)
  }

  private remember(sessionId: string, meta: Parameters<typeof merge>[1]) {
    const next = merge(this.state(sessionId), meta)
    this.states.set(sessionId, next)
    this.cacheDiscovery(next)
    return next
  }

  /**
   * Promote one session's discovery answers to the process-wide cache the
   * config-option probe reads.
   *
   * Only dedicated probe processes use this cache. Empty answers clear earlier
   * discovery; session readers use configOptions(agentSessionId) instead.
   */
  private cacheDiscovery(state: ACPState) {
    this.cachedConfigOptions = state.cfg ?? []
    this.cachedResolvedModel = resolvedModel(state) ?? null
  }

  configOptions(agentSessionId: string) {
    const state = this.state(agentSessionId)
    const model = resolvedModel(state)
    return { options: state.cfg ?? [], ...(model ? { resolvedModel: model } : {}) }
  }

  /**
   * Permission modes for one agent session.
   *
   * Keyed on the AGENT session id, the same key `states` uses — not Claxedo's
   * session id. The adapter translates before calling in.
   */
  permissionModes(agentSessionId: string): AgentPermissionModeState {
    return permissionModes(this.state(agentSessionId))
  }

  async setPermissionMode(agentSessionId: string, modeId: string): Promise<AgentPermissionModeState> {
    const { state, result } = await setPermissionMode(this.agent, this.state(agentSessionId), agentSessionId, modeId)
    this.states.set(agentSessionId, state)
    // `set_config_option` returns the complete option list, which becomes the
    // shared discovery cache.
    this.cacheDiscovery(state)
    return result
  }

  /** Derive available agents from any session state or cached config options. */
  getAgents(): Array<{ name: string; description?: string; mode: string }> {
    // Session state is the live source when a session exists.
    for (const state of this.states.values()) {
      const agents = extractAgents(state)
      if (agents.length > 0) return agents
    }
    // The probe cache supplies discovery data before the first session prompt.
    if (this.cachedConfigOptions) {
      const agents = extractAgents({
        caps: this.caps,
        prompt: null,
        cfg: this.cachedConfigOptions,
        modes: [],
      })
      if (agents.length > 0) return agents
    }
    return []
  }

  async newSession(workingDirectory: string, _title?: string, sessionId?: string, start?: AgentSessionStartBinding, timeoutMs = newSessionTimeoutMs()): Promise<string> {
    this.resetIdleTimer()
    const started = Date.now()
    log.info("ACP newSession: calling session/new", { workingDirectory })
    const params: NewSessionRequest = { cwd: workingDirectory, mcpServers: this.mcp(sessionId) }
    const lease = createStartupRequestLease(start ? timeoutMs : undefined, this.leaseIdle())
    if (start) this.startingRequests.set(params, { start, quiet: lease.quiet!, controller: lease.controller })
    try {
      const request = this.agent.request(methods.agent.session.new, params, { cancellationSignal: lease.controller.signal })
      const result = await lease.wait(request)
      this.remember(result.sessionId, result)
      this.loadedSessions.add(result.sessionId)
      log.info("ACP newSession: got sessionId", { agentSessionId: result.sessionId, ms: Date.now() - started })
      return result.sessionId
    } finally {
      lease.release()
      if (start) this.startingRequests.delete(params)
    }
  }

  async resumeSession(agentSessionId: string, workingDirectory: string, sessionId?: string) {
    this.assertSessionReady(agentSessionId)
    if (this.hasSession(agentSessionId)) return
    this.restorations ??= new Map()
    const existing = this.restorations.get(agentSessionId)
    if (existing) return existing
    const pending = this.restoreSession(agentSessionId, workingDirectory, sessionId)
    this.restorations.set(agentSessionId, pending)
    try { await pending }
    finally {
      if (this.restorations.get(agentSessionId) === pending) this.restorations.delete(agentSessionId)
    }
  }

  private async restoreSession(agentSessionId: string, workingDirectory: string, sessionId?: string) {
    this.resetIdleTimer()
    const t0 = Date.now()
    const state = this.state(agentSessionId)
    const kind =
      state.caps?.sessionCapabilities?.resume
        ? "resume"
        : state.caps?.loadSession
          ? "load"
          : "none"
    const pid = this.transport.pid ?? null
    log.info("ACP session restore: starting", {
      agentSessionId,
      workingDirectory,
      kind,
      pid,
      modeCount: state.modes.length,
      hasCfg: !!state.cfg?.length,
    })
    const stop = watch("resumeSession", { agentSessionId, workingDirectory, kind, pid })
    try {
      const result = await resume(this.agent, state, agentSessionId, workingDirectory, this.mcp(sessionId))
      this.states.set(agentSessionId, result.state)
      this.loadedSessions.add(agentSessionId)
      this.cacheDiscovery(result.state)
      log.info("ACP session restored", { agentSessionId, kind: result.kind, pid, ms: Date.now() - t0 })
    } catch (err) {
      log.error("ACP session restore failed", {
        agentSessionId,
        workingDirectory,
        kind,
        pid,
        err,
        ms: Date.now() - t0,
      })
      throw err
    } finally {
      stop()
    }
  }

  async syncSession(agentSessionId: string, input: PromptInput, options: { syncMode?: boolean } = {}) {
    this.assertSessionReady(agentSessionId)
    this.resetIdleTimer()
    const t0 = Date.now()
    const state = this.state(agentSessionId)
    const pid = this.transport.pid ?? null
    log.info("ACP session sync: starting", {
      agentSessionId,
      agent: input.agent,
      permissionMode: input.permissionMode ?? null,
      model: input.model?.modelID,
      variant: input.variant ?? null,
      pid,
      modeCount: state.modes.length,
      hasCfg: !!state.cfg?.length,
    })
    const stop = watch("syncSession", {
      agentSessionId,
      agent: input.agent,
      model: input.model?.modelID,
      variant: input.variant ?? null,
      pid,
    })
    try {
      const next = await sync(this.agent, state, agentSessionId, input, options)
      this.states.set(agentSessionId, next)
      this.cacheDiscovery(next)
      log.info("ACP session synced", {
        agentSessionId,
        agent: input.agent,
        model: input.model?.modelID,
        variant: input.variant ?? null,
        pid,
        ms: Date.now() - t0,
      })
    } catch (err) {
      log.error("ACP session sync failed", {
        agentSessionId,
        agent: input.agent,
        model: input.model?.modelID,
        variant: input.variant ?? null,
        pid,
        err,
        ms: Date.now() - t0,
      })
      throw err
    } finally {
      stop()
    }
  }

  async prompt(
    agentSessionId: string,
    input: PromptInput,
    onUpdate: (update: SessionUpdate) => void,
    /** Filesystem delivery is controlled by explicit connection reachability. */
    directory: string,
    onUncertain?: (error: AcpSessionUncertainError) => void,
  ): Promise<{ stopReason: StopReason; usage?: Usage | null }> {
    this.resetIdleTimer()
    this.assertSessionReady(agentSessionId)

    if (this.activePrompts.has(agentSessionId)) {
      throw new Error(`ACP session ${agentSessionId} already has an active prompt`)
    }
    this.activePrompts.add(agentSessionId)
    this.uncertaintyListeners ??= new Map()
    this.uncertaintyReported ??= new Set()
    if (onUncertain) this.uncertaintyListeners.set(agentSessionId, onUncertain)

    log.info("ACP prompt: starting", {
      agentSessionId,
      partCount: input.parts.length,
      timeoutMs: promptTimeoutMs(),
    })

    const t0 = Date.now()
    // A prompt is active work for its whole duration, including quiet tool calls.
    const idleLease = this.leaseIdle()
    try {
      const prompt = await blocks({
        parts: input.parts,
        system: input.system,
        caps: this.state(agentSessionId).prompt,
        ...(this.transport.sharedFilesystem === true ? { directory } : {}),
      })

      // The only bound on a turn is the agent going quiet: a tool call that
      // streams nothing for this long, with no permission waiting on the human,
      // is a wedged agent. Wall-clock length is never a failure.
      let rejectQuiet!: (err: Error) => void
      const quietPromise = new Promise<never>((_, reject) => {
        rejectQuiet = reject
      })
      const quiet = createIdleReaper({
        idleMs: promptTimeoutMs(),
        onIdle: () => rejectQuiet(new Error(`ACP prompt timed out after ${promptTimeoutMs()}ms of inactivity`)),
      })
      quiet.touch()
      this.promptQuiet.set(agentSessionId, quiet)

      this.sessionListeners.set(agentSessionId, (update: SessionUpdate) => {
        quiet.touch()
        this.resetIdleTimer()
        onUpdate(update)
      })

      const request = this.agent.request(methods.agent.session.prompt, { sessionId: agentSessionId, prompt })
      let settled = false
      const settlement = request.then(() => { settled = true }, () => { settled = true })
      this.promptSettlements.set(agentSessionId, settlement)
      try {
        const result = await Promise.race([
          request,
          quietPromise,
        ])
        log.info("ACP prompt: completed", {
          agentSessionId,
          stopReason: result.stopReason,
          ms: Date.now() - t0,
        })
        return { stopReason: result.stopReason, usage: result.usage }
      } catch (err) {
        // A rejected RPC has settled. Silence is different: cancellation must
        // settle before another prompt may enter this agent session.
        if (!settled && this.alive) {
          try {
            await this.cancelAndWait(agentSessionId)
          } catch (cancellationError) {
            if (this.alive) {
              const uncertainty = cancellationError instanceof AcpSessionUncertainError ? cancellationError
                : new AcpSessionUncertainError(agentSessionId, `ACP cancellation failed: ${String(cancellationError)}. The original turn is still being observed; it was not retried.`)
              this.quarantineSession(agentSessionId, settlement)
              this.reportUncertain(agentSessionId, uncertainty)
            }
          }
          // Observation timeout is not execution completion. Keep the canonical
          // listener and its caller's turn fence until the ORIGINAL RPC settles.
          const result = await request
          return { stopReason: result.stopReason, usage: result.usage }
        }
        throw err
      } finally {
        void settlement.then(() => {
          if (this.promptSettlements.get(agentSessionId) === settlement) this.promptSettlements.delete(agentSessionId)
        })
        quiet.cancel()
        if (this.promptQuiet.get(agentSessionId) === quiet) this.promptQuiet.delete(agentSessionId)
      }
    } catch (err) {
      log.error("ACP prompt: error", { agentSessionId, err, ms: Date.now() - t0 })
      throw err
    } finally {
      this.sessionListeners.delete(agentSessionId)
      this.uncertaintyListeners.delete(agentSessionId)
      this.uncertaintyReported.delete(agentSessionId)
      // A timed-out caller is not proof that the agent stopped executing.
      // Keep the process leased until the original prompt actually settles.
      const pending = this.promptSettlements.get(agentSessionId)
      if (pending) void pending.then(() => idleLease.release())
      else idleLease.release()
      this.activePrompts.delete(agentSessionId)
    }
  }

  /** Observe lifecycle notifications which may arrive after a prompt response. */
  observeCommands(agentSessionId: string, observer: (update: SessionUpdate) => void) {
    this.commandListeners.set(agentSessionId, observer)
    const update = this.commandUpdates.get(agentSessionId)
    if (update) observer(update)
  }

  unobserveCommands(agentSessionId: string) {
    this.commandListeners.delete(agentSessionId)
    this.commandUpdates.delete(agentSessionId)
  }

  observeSession(agentSessionId: string, observer: (update: SessionUpdate) => void) {
    this.sessionObservers.set(agentSessionId, observer)
    return () => {
      if (this.sessionObservers.get(agentSessionId) === observer) this.sessionObservers.delete(agentSessionId)
    }
  }

  sessionIsWithin(id: string, ancestor: string) {
    const seen = new Set<string>()
    for (let current: string | undefined = id; current && !seen.has(current); current = this.childParents.get(current)) {
      if (current === ancestor) return true
      seen.add(current)
    }
    return false
  }

  async cancel(agentSessionId: string): Promise<void> {
    this.elicitationCancel?.(agentSessionId)
    for (const child of this.childParents.keys()) {
      if (child !== agentSessionId && this.sessionIsWithin(child, agentSessionId)) this.elicitationCancel?.(child)
    }
    for (const [id, pending] of this.pendingPermissions) {
      if (this.sessionIsWithin(pending.aid, agentSessionId)) this.respondPermission(id, { outcome: { outcome: "cancelled" } })
    }
    log.info("ACP cancel", { agentSessionId })
    await this.agent.notify(methods.agent.session.cancel, { sessionId: agentSessionId })
  }

  private reportUncertain(agentSessionId: string, error: AcpSessionUncertainError) {
    this.uncertaintyReported ??= new Set()
    if (this.uncertaintyReported.has(agentSessionId)) return
    this.uncertaintyReported.add(agentSessionId)
    this.uncertaintyListeners?.get(agentSessionId)?.(error)
  }

  async cancelAndWait(agentSessionId: string, timeoutMs = newSessionTimeoutMs()): Promise<void> {
    const pending = this.promptSettlements.get(agentSessionId)
    try {
      await this.cancel(agentSessionId)
    } catch (error) {
      if (pending) {
        this.quarantineSession(agentSessionId, pending)
        const uncertain = new AcpSessionUncertainError(agentSessionId, "ACP cancellation could not be sent. The original turn is still being observed; it was not retried.")
        this.reportUncertain(agentSessionId, uncertain)
        throw uncertain
      }
      throw error
    }
    if (!pending) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.quarantineSession(agentSessionId, pending)
            const error = new AcpSessionUncertainError(agentSessionId, "ACP cancellation was not acknowledged. The original turn is still being observed; it was not retried.")
            this.reportUncertain(agentSessionId, error)
            reject(error)
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  respondPermission(permId: string, response: RequestPermissionResponse): void {
    const pending = this.pendingPermissions.get(permId)
    if (pending) {
      log.info("ACP respondPermission: resolving", { permId, tool: pending.tool })
      pending.resolve(response)
      this.pendingPermissions.delete(permId)
    } else {
      log.info("ACP respondPermission: permId not found in pending map", { permId })
    }
  }

  supportsForkSession(agentSessionId?: string) {
    const state = agentSessionId ? this.state(agentSessionId) : undefined
    return !!(state?.caps ?? this.caps)?.sessionCapabilities?.fork
  }

  async forkSession(agentSessionId: string, workingDirectory: string, sessionId?: string): Promise<string> {
    this.resetIdleTimer()
    const fork = await this.agent.request(methods.agent.session.fork, {
      sessionId: agentSessionId,
      cwd: workingDirectory,
      mcpServers: this.mcp(sessionId),
    })
    this.remember(fork.sessionId, fork)
    this.loadedSessions.add(fork.sessionId)
    return fork.sessionId
  }

  /**
   * `reason` becomes the failure every request still in flight on this
   * process sees, so a session sharing a wedged process learns why its
   * turn died instead of a bare "connection closed".
   */
  dispose(reason?: string): Promise<RetirementResult | undefined> {
    if (this.disposed) return this.exit.retirement ?? Promise.resolve(undefined)
    this.disposed = true
    this.connectionObservation?.({ state: "disconnected", reason: "disposed" })
    const replaced = reason ? new Error(`ACP process replaced: ${reason}`) : undefined
    if (replaced) this.exit.retain(replaced)
    this.sessionObservers.clear()
    this.commandListeners.clear()
    this.commandUpdates.clear()
    this.goalListeners.clear()
    this.goalUpdateListeners.clear()
    this.exitObservation({ reason: "disposed" })
    this.idle.cancel()
    log.info("ACP transport dispose", { directory: this.directory, kind: this.transport.kind, reason })
    this.connection.close(replaced)
    return this.exit.retire()
  }

  private exitObservation(input: { reason: "exited" | "error" | "disposed"; exitCode?: number }) {
    if (this.observationExited) return
    this.observationExited = true
    this.observationExit = input
    this.observation?.exit(input)
  }

  get alive(): boolean {
    return this.transport.alive && !this.exit.reason && !this.deadNotified
  }

  /**
   * How this agent is actually reached, as opposed to how it was configured.
   * Only `process` puts the agent on this machine, which is what decides
   * whether a settled prompt is evidence about the agent or about the wire.
   */
  get transportKind() {
    return this.transport.kind
  }
}
