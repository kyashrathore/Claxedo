import { randomUUID } from "crypto"
import {
  client,
  methods,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
  type InitializeResponse,
  type McpServer,
  type PermissionOption,
  type RequestPermissionRequest,
  type ToolKind,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
  type Usage,
} from "@agentclientprotocol/sdk"
import type { PromptInput } from "../../index"
import { Log } from "../../log"
import { blocks, extractAgents, init, merge, resume, sync, type ACPState } from "./session"
import { IDLE_TIMEOUT_MS, promptTimeoutMs, watch } from "./helpers"
import type { ACPTransport, ACPTransportEnv, ACPTransportFactory } from "./transport"
import type { AgentProcessObserverHandle } from "../../process-observer"

const log = Log.create({ service: "acp-adapter" })

export type SessionUpdate = SessionNotification["update"]
/**
 * `tool` is the agent's human-readable `toolCall.title` ("Read file src/index.ts");
 * `kind` is the protocol's machine-readable `ToolKind` classification. Both are
 * strings, so they are passed BY NAME — transposing them positionally would
 * silently reintroduce the bug this shape exists to prevent.
 */
export type PermissionPushPayload = {
  permId: string
  tool: string
  kind?: ToolKind
  paths: string[]
}

export type PermissionPusher = (payload: PermissionPushPayload) => void

export interface PendingPermission {
  aid: string
  tool: string
  /** Protocol classification; absent when the agent does not send one. */
  kind?: ToolKind
  paths: string[]
  options: PermissionOption[]
  resolve: (response: RequestPermissionResponse) => void
}

// ── Shared ACP process ───────────────────────────────────────────────────────

export class ACPProcess {
  private transport!: ACPTransport
  readonly connection: ClientConnection
  readonly agent: ClientContext
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private caps: InitializeResponse["agentCapabilities"] | null = null
  readonly pendingPermissions = new Map<string, PendingPermission>()
  // agentSessionId → update listener
  readonly sessionListeners = new Map<string, (update: SessionUpdate) => void>()
  private states = new Map<string, ACPState>()
  // agentSessionId → permission pusher
  readonly permissionPushers = new Map<string, PermissionPusher>()
  /** Cached config options from newSession() response or config_option_update notifications */
  cachedConfigOptions: SessionConfigOption[] | null = null
  // Serial queue: ACP processes one prompt at a time per process
  private promptQueue: Promise<void> = Promise.resolve()
  private promptQueueDepth = 0
  private lastStderr = ""
  private exitReason: Error | null = null
  private exitWaiters: Array<(err: Error) => void> = []
  private deadNotified = false
  private disposed = false
  private observation: AgentProcessObserverHandle | undefined
  private observationExited = false
  private observationExit: { reason: "exited" | "error" | "disposed"; exitCode?: number } | undefined

  constructor(
    readonly directory: string,
    binary: string,
    args: string[],
    model: string,
    private readonly mcp: () => McpServer[],
    private readonly onDead: () => void,
    createTransport: ACPTransportFactory,
    private readonly env: () => ACPTransportEnv,
    observe?: (input: {
      pid?: number
      kind: ACPTransport["kind"]
    }) => AgentProcessObserverHandle,
  ) {
    this.transport = createTransport({
      directory,
      binary,
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
        this.failExitWaiters(new Error(this.exitMessage(code, signal)))
        this.notifyDead()
      },
      onError: (err) => {
        log.error("ACP transport error", { err, binary, directory, kind: this.transport?.kind })
        this.exitObservation({ reason: "error" })
        this.failExitWaiters(err)
        this.notifyDead()
      },
    })
    this.observation = observe?.({
      ...(this.transport.pid ? { pid: this.transport.pid } : {}),
      kind: this.transport.kind,
    })
    if (this.observationExit) this.observation?.exit(this.observationExit)
    log.info("ACP transport created", this.transport.metadata)

    this.connection = client({ name: "claxedo-workspace-runtime" })
      .onNotification(methods.client.session.update, async ({ params }) => {
        const kind = params.update?.sessionUpdate ?? "(unknown)"
        log.info("ACP sessionUpdate received", {
          sessionId: params.sessionId,
          kind,
          hasListener: this.sessionListeners.has(params.sessionId),
        })
        // Always cache config options (even without a per-session listener)
        if (params.update?.sessionUpdate === "config_option_update") {
          const opts = (params.update as { configOptions: SessionConfigOption[] }).configOptions
          this.remember(params.sessionId, { configOptions: opts })
          log.info("ACP sessionUpdate: cached config options", { count: opts.length })
        }
        const listener = this.sessionListeners.get(params.sessionId)
        if (!listener) {
          log.info("ACP sessionUpdate: no listener registered, dropping update", {
            sessionId: params.sessionId,
            kind,
          })
          return
        }
        listener(params.update)
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        const permId = randomUUID()
        const toolCall = params.toolCall
        const tool = toolCall.title ?? "unknown"
        // `title` is prose for display; `kind` is the classification any policy
        // decision must key on. Forwarding only the title left every consumer
        // matching against strings like "Read file src/index.ts".
        // ACP types this as `ToolKind | null | undefined`; collapse the null so
        // downstream only has to handle "absent".
        const kind = toolCall.kind ?? undefined
        const paths: string[] = []
        const hasListener = this.sessionListeners.has(params.sessionId)

        log.info("ACP requestPermission received", {
          sessionId: params.sessionId,
          tool,
          kind,
          permId,
          optionKinds: params.options.map((o) => o.kind),
          hasListener,
        })

        return new Promise<RequestPermissionResponse>((resolve) => {
          this.pendingPermissions.set(permId, {
            aid: params.sessionId,
            tool,
            kind,
            paths,
            options: params.options,
            resolve,
          })

          // Push permission-request directly via the registered pusher (no synthetic injection)
          const pusher = this.permissionPushers.get(params.sessionId)
          if (pusher) {
            log.info("ACP requestPermission: pushing permission-request to stream", {
              permId,
              tool,
            })
            pusher({ permId, tool, kind, paths: (params.toolCall.locations ?? []).map((l) => l.path) })
          } else {
            log.info(
              "ACP requestPermission: no active pusher — permission stored but not forwarded to frontend yet",
              { permId, tool, kind, sessionId: params.sessionId },
            )
          }
        })
      })
      .connect(this.transport.stream)

    this.agent = this.connection.agent
    void this.connection.closed.then(() => {
      this.failExitWaiters(new Error(this.connectionClosedMessage()))
      this.notifyDead()
    })
    this.resetIdleTimer()
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      log.info("ACP process idle timeout, disposing", { directory: this.directory, idleMs: IDLE_TIMEOUT_MS })
      this.dispose()
    }, IDLE_TIMEOUT_MS)
  }

  private exitMessage(code: number | null, signal: NodeJS.Signals | null) {
    const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
    return this.lastStderr
      ? `ACP transport exited with ${status}: ${this.lastStderr}`
      : `ACP transport exited with ${status}`
  }

  private connectionClosedMessage() {
    return this.lastStderr
      ? `ACP connection closed: ${this.lastStderr}`
      : "ACP connection closed"
  }

  private failExitWaiters(err: Error) {
    this.exitReason ??= err
    for (const reject of this.exitWaiters) reject(this.exitReason)
    this.exitWaiters = []
  }

  private notifyDead() {
    if (this.deadNotified) return
    this.deadNotified = true
    if (!this.disposed) this.onDead()
  }

  private waitForExit() {
    if (this.exitReason) return Promise.reject(this.exitReason) as Promise<never>
    return new Promise<never>((_, reject) => {
      this.exitWaiters.push(reject)
    })
  }

  async initialize(): Promise<void> {
    this.resetIdleTimer()
    const t0 = Date.now()
    log.info("ACP initialize: starting handshake", { directory: this.directory })
    const result = await Promise.race([
      this.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "claxedo-workspace-runtime", version: "0.1.0" },
        clientCapabilities: {
          auth: { terminal: false },
          // Allow filesystem and terminal — the ACP binary will call requestPermission
          // before executing sensitive operations. Setting these false causes the binary
          // to auto-fail those tool calls without ever asking for permission.
          fs: { readTextFile: true, writeTextFile: true },
          plan: {},
          terminal: true,
        },
      }),
      this.waitForExit(),
    ])
    this.caps = result.agentCapabilities ?? null
    this.observation?.update({ lifecycle: "ready" })
    log.info("ACP initialize: handshake complete", { directory: this.directory, ms: Date.now() - t0 })
  }

  failureDetail() {
    return this.lastStderr
  }

  private state(sessionId: string) {
    return this.states.get(sessionId) ?? init(this.caps)
  }

  private remember(sessionId: string, meta: Parameters<typeof merge>[1]) {
    const next = merge(this.state(sessionId), meta)
    this.states.set(sessionId, next)
    if (next.cfg && next.cfg.length > 0) this.cachedConfigOptions = next.cfg
    return next
  }

  /** Derive available agents from any session state or cached config options. */
  getAgents(): Array<{ name: string; description?: string; mode: string }> {
    // Try extracting from the first available session state
    for (const state of this.states.values()) {
      const agents = extractAgents(state)
      if (agents.length > 0) return agents
    }
    // Fall back to cached config options (available even before a session prompt)
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

  async newSession(workingDirectory: string, _title?: string): Promise<string> {
    this.resetIdleTimer()
    const t0 = Date.now()
    log.info("ACP newSession: calling session/new", { workingDirectory })
    const result = await this.agent.request(methods.agent.session.new, {
      cwd: workingDirectory,
      mcpServers: this.mcp(),
    })
    this.remember(result.sessionId, result)
    log.info("ACP newSession: got sessionId", { agentSessionId: result.sessionId, ms: Date.now() - t0 })
    return result.sessionId
  }

  async resumeSession(agentSessionId: string, workingDirectory: string) {
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
      const result = await resume(this.agent, state, agentSessionId, workingDirectory, this.mcp())
      this.states.set(agentSessionId, result.state)
      if (result.state.cfg && result.state.cfg.length > 0) this.cachedConfigOptions = result.state.cfg
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

  async syncSession(agentSessionId: string, input: PromptInput) {
    this.resetIdleTimer()
    const t0 = Date.now()
    const state = this.state(agentSessionId)
    const pid = this.transport.pid ?? null
    log.info("ACP session sync: starting", {
      agentSessionId,
      agent: input.agent,
      model: input.model.modelID,
      variant: input.variant ?? null,
      pid,
      modeCount: state.modes.length,
      hasCfg: !!state.cfg?.length,
    })
    const stop = watch("syncSession", {
      agentSessionId,
      agent: input.agent,
      model: input.model.modelID,
      variant: input.variant ?? null,
      pid,
    })
    try {
      const next = await sync(this.agent, state, agentSessionId, input)
      this.states.set(agentSessionId, next)
      if (next.cfg && next.cfg.length > 0) this.cachedConfigOptions = next.cfg
      log.info("ACP session synced", {
        agentSessionId,
        agent: input.agent,
        model: input.model.modelID,
        variant: input.variant ?? null,
        pid,
        ms: Date.now() - t0,
      })
    } catch (err) {
      log.error("ACP session sync failed", {
        agentSessionId,
        agent: input.agent,
        model: input.model.modelID,
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
  ): Promise<{ stopReason: StopReason; usage?: Usage | null }> {
    this.resetIdleTimer()

    // Serialize: only one prompt runs at a time per ACP process.
    let slotRelease!: () => void
    const prev = this.promptQueue
    this.promptQueue = new Promise<void>((resolve) => { slotRelease = resolve })
    this.promptQueueDepth++

    if (this.promptQueueDepth > 1) {
      log.info("ACP prompt: waiting in serial queue", {
        agentSessionId,
        queueDepth: this.promptQueueDepth,
      })
    }
    await prev
    this.promptQueueDepth--

    log.info("ACP prompt: starting", {
      agentSessionId,
      partCount: input.parts.length,
      timeoutMs: promptTimeoutMs(),
    })

    const t0 = Date.now()
    try {
      const prompt = blocks(input.parts, input.system, this.state(agentSessionId).prompt)

      // Inactivity timeout: resets on every received update so long tool calls
      // don't hit the wall-clock limit. Only fires when the agent goes silent.
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      let rejectTimeout!: (err: Error) => void
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject
      })
      const resetTimeout = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        timeoutId = setTimeout(
          () => rejectTimeout(new Error(`ACP prompt timed out after ${promptTimeoutMs()}ms of inactivity`)),
          promptTimeoutMs(),
        )
      }
      resetTimeout()

      // Wrap the listener so every incoming update resets both the inactivity timer
      // and the process idle timer (prevents the process from being killed mid-prompt).
      this.sessionListeners.set(agentSessionId, (update: SessionUpdate) => {
        resetTimeout()
        this.resetIdleTimer()
        onUpdate(update)
      })

      try {
        const result = await Promise.race([
          this.agent.request(methods.agent.session.prompt, { sessionId: agentSessionId, prompt }),
          timeoutPromise,
        ])
        log.info("ACP prompt: completed", {
          agentSessionId,
          stopReason: result.stopReason,
          ms: Date.now() - t0,
        })
        return { stopReason: result.stopReason, usage: result.usage }
      } catch (err) {
        // On timeout (or any error), cancel the session so the ACP binary stops working
        // rather than continuing to run orphaned with no listener.
        log.info("ACP prompt: cancelling session after error/timeout", { agentSessionId })
        this.agent.notify(methods.agent.session.cancel, { sessionId: agentSessionId }).catch(() => {})
        throw err
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      }
    } catch (err) {
      log.error("ACP prompt: error", { agentSessionId, err, ms: Date.now() - t0 })
      throw err
    } finally {
      this.sessionListeners.delete(agentSessionId)
      slotRelease()
    }
  }

  async cancel(agentSessionId: string): Promise<void> {
    log.info("ACP cancel", { agentSessionId })
    await this.agent.notify(methods.agent.session.cancel, { sessionId: agentSessionId })
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

  async forkSession(agentSessionId: string, workingDirectory: string): Promise<string> {
    this.resetIdleTimer()
    const fork = await this.agent.request(methods.agent.session.fork, {
      sessionId: agentSessionId,
      cwd: workingDirectory,
      mcpServers: this.mcp(),
    })
    this.remember(fork.sessionId, fork)
    return fork.sessionId
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.exitObservation({ reason: "disposed" })
    if (this.idleTimer) clearTimeout(this.idleTimer)
    log.info("ACP transport dispose", { directory: this.directory, kind: this.transport.kind })
    this.connection.close()
    this.transport.dispose()
  }

  private exitObservation(input: { reason: "exited" | "error" | "disposed"; exitCode?: number }) {
    if (this.observationExited) return
    this.observationExited = true
    this.observationExit = input
    this.observation?.exit(input)
  }

  get alive(): boolean {
    return this.transport.alive
  }
}
