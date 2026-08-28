/**
 * ACP harness adapter
 *
 * Drives ACP-compatible agents through @agentclientprotocol/sdk and a swappable
 * ACP transport. The default transport is local stdio, but callers can inject
 * another transport implementation.
 *
 * Keeps one ACP process per harness/workspace/config key, lazily spawned and
 * idle-disposed after CLAXEDO_ACP_IDLE_TIMEOUT_MS. Many local sessions can bind
 * to provider ACP sessions inside that one process. A separate probe process
 * discovers config options without blocking active sessions.
 *
 * Persists session mappings and replay events through an injected
 * AcpRuntimeStore; the host owns the concrete backing store.
 *
 * Runtime flow:
 *   ACP session/update → agent-event-runtime ACP translator → turn projector → compat/SSE events
 *   prompt stopReason  → session status / finish events when terminal
 *   requestPermission  → compat permission request, resolved by respondPermission()
 */

import { createHash, randomUUID } from "crypto"
import {
  type PermissionOptionKind,
  type McpServer,
  type StopReason,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk"
import {
  createAgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import {
  acpCodexCollaborationStates,
  createAcpEventTranslator,
  classifyAcpSubagentUpdate,
  type AcpSubagentObservation,
  translateStopReason,
} from "@claxedo/agent-event-runtime/harnesses/acp"
import {
  buildAssistantMessage,
  buildUserMessage,
  isTerminalCompatEvent,
  messageUpdated,
  permissionAsked,
  permissionReplied,
  sessionError,
  sessionStatus,
  type CompatEvent,
} from "../../compat-events"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type {
  AgentAgentRow,
  AgentCommandRow,
  AgentConfigOptionRow,
  AgentMessageRow,
  AgentPermissionRow,
  AgentRuntimeStreamEvent,
  AgentSessionRow,
  PromptInput,
  SessionConfig,
  SessionConfigUpdate,
} from "../../index"
import type {
  AbortResult,
  AgentHarnessAdapter,
  AgentHarnessAdapterHealth,
  AgentInteractionResult,
  AgentHarnessAdapterProcessOptions,
  AgentPermissionModeState,
} from "../../adapter-contract"
import { harnessCapabilities, type HarnessCapabilities, type HarnessCapabilityContext } from "../../capabilities"
import { draftPermissionModes, extractAgents, rememberLiveModes } from "./session"
import { acpPermissionRequest, permissionOptionPreference, selectPermissionOption } from "./permission-options"
import { listCommands } from "../../command-discovery"
import { firstTurnErrorData } from "../../first-turn-error"
import { Log } from "../../log"
import { ACP_RECOVER } from "./recovery"
import { recovering } from "../../status"
import { toAcpMcpServers, type ResolvedMcpServer } from "../../mcp-resolver"
import { createTurnEventProjector } from "../shared/turn-projection"
import { createChildEventRouter, type ChildProjectionTarget } from "../shared/child-event-routing"
import { createSessionTurnLifecycle, type SessionTurnLifecycle } from "../shared/turn-lifecycle"
import {
  createMemorySubagentAdmissionStore,
  createSubagentAdmissionBoundary,
  type SubagentAdmissionStore,
} from "../../subagent-admission"
import { requireWorkspaceDirectory } from "../../target"
import {
  createStdioACPTransport,
  type ACPTransportEnv,
  type ACPTransportFactory,
} from "./transport"
import { ACPProcess, type SessionUpdate } from "./process"
import {
  envFromConfig,
  errorCode,
  errorMessage,
  JSON_RPC_INTERNAL_ERROR,
  initializeTimeoutMs,
  mergeAcpEnv,
  messageUsage,
  missing,
  newSessionTimeoutMs,
  probeTimeoutMs,
  promptTimeoutMs,
  runtimeUsage,
  sameAcpEnv,
  sameAcpMcp,
} from "./helpers"
import { maybeAutoTitle } from "./title"
import { codexAcpLaunch } from "./codex-config"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"

const log = Log.create({ service: "acp-adapter" })

export type AcpRuntimeStore = AgentRuntimeStoreWithRecovery

export type AcpHarnessAdapterOptions = AgentHarnessAdapterProcessOptions & {
  binary: string
  harness?: string
  args?: string[]
  env?: ACPTransportEnv
  /**
   * `false` keeps MCP servers out of everything offered to this agent —
   * session requests, process fingerprints, and process observation. See
   * `ProcessHarnessConnection.supportsMcpServers`.
   */
  supportsMcpServers?: boolean
  storeRoot?: string
  store?: AcpRuntimeStore
  createStore?: (storeRoot?: string) => AcpRuntimeStore
  eventHub?: RuntimeEventHub
  createTransport?: ACPTransportFactory
  subagentAdmissionStore?: SubagentAdmissionStore
  materializeSubagent?: (input: {
    parentSessionId: string
    parentAgentSessionId: string
    directory: string
    event: import("@claxedo/agent-event-runtime").SubagentUpdatedEvent
    prompt: Pick<PromptInput, "userMessageId" | "agent" | "model" | "variant">
  }) => Promise<ChildProjectionTarget | undefined> | ChildProjectionTarget | undefined
}

export {
  createHttpACPTransportFactory,
  createStreamableHttpACPTransportFactory,
  createWebSocketACPTransportFactory,
} from "./transport"
export type {
  ACPHttpTransportFactoryOptions,
  ACPTransport,
  ACPTransportEnv,
  ACPTransportFactory,
  ACPTransportFactoryInput,
  ACPStreamableHttpTransportFactoryOptions,
  ACPWebSocketTransportFactoryOptions,
} from "./transport"

function missingStore(): AcpRuntimeStore {
  throw new Error("AcpHarnessAdapter requires a runtime store from the host")
}

type ACPProcessKey = string
type ProcEntry = {
  key: ACPProcessKey
  directory: string
  proc: ACPProcess | null
  init: Promise<{ proc: ACPProcess; isNew: boolean }> | null
  sessionIds: Set<string>
}
type ProbeEntry = {
  directory: string
  proc: ACPProcess | null
  init: Promise<ACPProcess> | null
}
type ActiveAcpTurn = {
  drain(message: string): void
}

const activePromptCounts = new Map<string, number>()
const activePromptWaiters = new Map<string, Set<() => void>>()

function activePromptCount(harness: string) {
  return activePromptCounts.get(harness) ?? 0
}

function enterActivePrompt(harness: string) {
  activePromptCounts.set(harness, activePromptCount(harness) + 1)
  return () => {
    const next = activePromptCount(harness) - 1
    if (next > 0) {
      activePromptCounts.set(harness, next)
      return
    }
    activePromptCounts.delete(harness)
    for (const resolve of activePromptWaiters.get(harness) ?? []) resolve()
    activePromptWaiters.delete(harness)
  }
}

function waitForNoActivePrompts(harness: string) {
  if (activePromptCount(harness) === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const waiters = activePromptWaiters.get(harness) ?? new Set<() => void>()
    waiters.add(resolve)
    activePromptWaiters.set(harness, waiters)
  })
}

function root() {
  return process.cwd()
}

function stable(input: unknown): unknown {
  if (!input || typeof input !== "object") return input
  if (Array.isArray(input)) return input.map(stable)
  return Object.fromEntries(
    Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, stable(value)]),
  )
}

function stableKey(input: unknown) {
  return JSON.stringify(stable(input))
}

function fingerprint(input: unknown) {
  return `acp:${createHash("sha256").update(stableKey(input)).digest("hex")}`
}

function executableBasename(input: string) {
  return input.split(/[\\/]/).at(-1) || "agent"
}

function unrestorable(harness: string, err: unknown) {
  if (missing(err)) return true
  // Codex ACP reports a generic internal error when a session created by a
  // disposed process cannot be resumed. This happens safely before prompt
  // submission, so replace the agent-side session and preserve the durable
  // Claxedo Session identity.
  //
  // Matched on the JSON-RPC code, NOT on the rendered message: codex-acp routes
  // its failures through `RequestError.internalError(details)`, so the message
  // carries whatever detail text it had and an equality test against
  // "Internal error" stops matching precisely when a detail is present.
  if (harness === "codex" && errorCode(err) === JSON_RPC_INTERNAL_ERROR) return true
  return harness === "cursor" && errorMessage(err).includes("Invalid params")
}

// ── AcpHarnessAdapter ────────────────────────────────────────────────────────────────

export class AcpHarnessAdapter implements AgentHarnessAdapter {
  readonly adapterCapabilities = ["runtime-config"] as const
  readonly commitsStreamEvents = true
  private store: AcpRuntimeStore
  private ownsStore = false
  private storeClosed = false
  private currentModel = ""
  private currentEnv: ACPTransportEnv = {}
  private currentMcp: McpServer[] = []
  private turnLifecycle = createSessionTurnLifecycle<ActiveAcpTurn>()
  private processes = new Map<ACPProcessKey, ProcEntry>()
  private sessionProcesses = new Map<string, ACPProcessKey>()
  private ignoreStoredProcessKeys = false
  private permissionOwners = new Map<string, ACPProcess>()
  private probe: ProbeEntry | null = null
  private configRestartPending = false
  private subagentAdmissions?: SubagentAdmissionStore

  constructor(private readonly options: AcpHarnessAdapterOptions) {
    this.store = options.store ?? options.createStore?.(options.storeRoot) ?? missingStore()
    this.ownsStore = !options.store
    this.currentEnv = options.env ?? {}
  }

  private harnessId(): string {
    return this.options?.harness ?? "claude"
  }

  private acpClient() {
    return `${this.harnessId()}-acp`
  }

  private lifecycle(): SessionTurnLifecycle<ActiveAcpTurn> {
    this.turnLifecycle ??= createSessionTurnLifecycle<ActiveAcpTurn>()
    return this.turnLifecycle
  }

  private subagentAdmissionStore() {
    return this.options.subagentAdmissionStore ?? (this.subagentAdmissions ??= createMemorySubagentAdmissionStore())
  }

  private processMap() {
    this.processes ??= new Map<ACPProcessKey, ProcEntry>()
    return this.processes
  }

  private sessionProcessMap() {
    this.sessionProcesses ??= new Map<string, ACPProcessKey>()
    return this.sessionProcesses
  }

  private legacySessions() {
    return (this as unknown as { sessions?: Map<string, { proc?: ACPProcess | null; directory?: string; init?: unknown }> }).sessions
  }

  private processEntries(): Iterable<{ proc?: ACPProcess | null }> {
    const processes = this.processMap()
    if (processes.size > 0) return processes.values()
    return this.legacySessions()?.values() ?? []
  }

  private processKey(directory: string): ACPProcessKey {
    const options = this.options ?? { binary: "" }
    return fingerprint({
      harness: this.harnessId(),
      access: "acp",
      directory,
      binary: options.binary,
      args: options.args ?? [],
      transport: options.createTransport ? "custom" : "stdio",
      env: this.currentEnv ?? {},
      mcp: this.currentMcp ?? [],
      model: this.currentModel || null,
    })
  }

  private keyForSession(id: string, directory: string): ACPProcessKey {
    const key = this.sessionProcessMap().get(id) ?? (this.ignoreStoredProcessKeys ? null : this.store.getSessionOwnerKey?.(id)) ?? this.processKey(directory)
    this.sessionProcessMap().set(id, key)
    return key
  }

  private process(key: ACPProcessKey, directory: string) {
    const hit = this.processMap().get(key)
    if (hit) {
      hit.directory = directory
      return hit
    }
    const next: ProcEntry = {
      key,
      directory,
      proc: null,
      init: null,
      sessionIds: new Set(),
    }
    this.processMap().set(key, next)
    return next
  }

  private forgetSessionProcessBindings() {
    this.sessionProcessMap().clear()
    this.ignoreStoredProcessKeys = true
  }

  private invalidateProcess(
    key: ACPProcessKey,
    message = ACP_RECOVER,
    proc?: ACPProcess | null,
    options?: { dispose?: boolean; recover?: boolean },
  ) {
    const entry = this.processMap().get(key)
    const target = proc ?? entry?.proc ?? null
    if (entry) {
      if (!target || entry.proc === target) entry.proc = null
      entry.init = null
    }
    if (target) {
      for (const [permId, owner] of this.permissionOwnerMap()) {
        if (owner !== target) continue
        this.permissionOwnerMap().delete(permId)
        this.store.stalePermission?.(permId)
      }
      if (options?.dispose !== false) target.dispose()
    }
    if (options?.recover === false) return
    if (this.store.markSessionsInterruptedByOwner) {
      this.store.markSessionsInterruptedByOwner(key, message)
      return
    }
    for (const sessionId of entry?.sessionIds ?? []) {
      if (this.store.getSession?.(sessionId)) this.store.markSessionInterrupted?.(sessionId, message)
    }
  }

  private restartProcess(key: ACPProcessKey) {
    const entry = this.processMap().get(key)
    for (const id of entry?.sessionIds ?? []) {
      this.lifecycle().drain(id, "ACP session process restarted")
    }
    entry?.proc?.dispose()
    if (!entry) return
    entry.proc = null
    entry.init = null
  }

  private restartProbe() {
    this.probe?.proc?.dispose()
    if (!this.probe) return
    this.probe.proc = null
    this.probe.init = null
  }

  private restart() {
    this.lifecycle().drainAll("ACP session process restarted")
    for (const key of this.processMap().keys()) {
      this.restartProcess(key)
    }
    this.restartProbe()
  }

  private closeStore() {
    if (!this.ownsStore || this.storeClosed) return
    this.storeClosed = true
    this.store.close?.()
  }

  setModel(model: string): void {
    if (this.currentModel === model) return
    if (this.lifecycle().activeTurns.size > 0) {
      throw new Error("ACP process config cannot change while a prompt is active")
    }
    this.currentModel = model
    this.restart()
    this.forgetSessionProcessBindings()
    log.info("ACP model updated, ACP session processes disposed", {
      model,
      harness: this.harnessId(),
      binary: this.options.binary,
    })
  }

  setAuth(keys: ACPTransportEnv): void {
    const next = mergeAcpEnv(this.currentEnv, keys)
    if (sameAcpEnv(this.currentEnv, next)) return
    if (this.lifecycle().activeTurns.size > 0) {
      throw new Error("ACP process config cannot change while a prompt is active")
    }
    this.currentEnv = next
    this.restart()
    this.forgetSessionProcessBindings()
    log.info("ACP env updated, ACP session processes disposed", {
      harness: this.harnessId(),
      binary: this.options.binary,
    })
  }

  private make(directory: string, role: "harness" | "probe", dead: () => void = () => {}) {
    const launch = this.harnessId() === "codex"
      ? codexAcpLaunch(this.commandArgs(), this.currentEnv)
      : { args: this.commandArgs(), env: this.currentEnv }
    const ownerId = `acp-${role}:${randomUUID()}`
    const launchId = randomUUID()
    return new ACPProcess(
      root(),
      this.options.binary,
      launch.args,
      this.currentModel,
      () => this.currentMcp,
      dead,
      this.options.createTransport ?? createStdioACPTransport,
      () => launch.env,
      (transport) => this.observeProcess({
        directory,
        launchId,
        ownerId,
        role,
        transport,
      }),
    )
  }

  private observeProcess(input: {
    directory: string
    launchId: string
    ownerId: string
    role: "harness" | "probe"
    transport: { pid?: number; kind: "stdio" | "streamable-http" | "websocket" }
  }): AgentProcessObserverHandle {
    const local = input.transport.kind === "stdio"
    const direct = local && input.transport.pid !== undefined
    const handles = [
      observeAgentProcess(this.options.processObserver, {
        ownerId: input.ownerId,
        launchId: input.launchId,
        harnessId: this.harnessId(),
        access: "acp",
        role: input.role,
        label: `${this.harnessId()} ACP ${input.role}`,
        locality: local ? "local-process" : "remote",
        confidence: direct ? "direct" : local ? "inferred" : "not-process-backed",
        capabilities: {
          resourceMetrics: local ? "process" : "none",
          ownerActions: false,
        },
        ...(input.transport.pid ? { pid: input.transport.pid } : {}),
        directory: input.directory,
        ...(local ? { executableBasename: executableBasename(this.options.binary) } : {}),
        transport: input.transport.kind,
      }),
      ...this.currentMcp.map((server) => observeAgentProcess(this.options.processObserver, {
        ownerId: `acp-mcp:${randomUUID()}`,
        launchId: randomUUID(),
        harnessId: this.harnessId(),
        access: "acp",
        role: "mcp" as const,
        label: `MCP ${server.name}`,
        locality: "command" in server ? "local-process" as const : "remote" as const,
        confidence: "command" in server ? "inferred" as const : "not-process-backed" as const,
        capabilities: {
          resourceMetrics: "command" in server ? "process" as const : "none" as const,
          ownerActions: false,
        },
        parentOwnerId: input.ownerId,
        directory: input.directory,
        mcpName: server.name,
        transport: "command" in server ? "stdio" as const : "streamable-http" as const,
        ...("command" in server ? { executableBasename: executableBasename(server.command) } : {}),
      })),
    ]
    return {
      update(event) {
        handles.forEach((handle) => handle.update(event))
      },
      exit(event) {
        handles.forEach((handle) => handle.exit(event))
      },
    }
  }

  /**
   * `cursor` prepends its `acp` SUBCOMMAND, which is not optional and not a
   * caller's choice.
   *
   * Claude and Codex ship dedicated adapter binaries that speak ACP the moment
   * they start. Cursor does not: `cursor-agent` is a general CLI whose default
   * behaviour is an interactive TUI, and `cursor-agent acp` is the hidden
   * subcommand that turns it into an ACP server. Spawning it without the
   * subcommand gets a TUI on a pipe, which hangs the handshake rather than
   * failing — so this leads `options.args` instead of being merged with them,
   * and a caller passing args cannot displace it.
   */
  private commandArgs() {
    const supplied = this.options.args ?? []
    // Skipped when the caller already leads with it, so a config or host that
    // still supplies `acp` explicitly gets one subcommand rather than two.
    const subcommand = this.harnessId() === "cursor" && supplied[0] !== "acp" ? ["acp"] : []
    const args = [...subcommand, ...supplied]
    if (this.harnessId() !== "codex" || !this.currentModel || this.currentModel === "default") return args
    return [...args, "-c", `model="${this.currentModel}"`]
  }

  private async getOrSpawnProcessForKey(key: ACPProcessKey, directory: string): Promise<{ proc: ACPProcess; isNew: boolean }> {
    const entry = this.process(key, directory)
    const live = entry.proc
    if (live?.alive) {
      log.info("ACP getOrSpawnProcess: reusing shared process", {
        key,
        directory,
        sessions: entry.sessionIds.size,
        harness: this.harnessId(),
      })
      return { proc: live, isNew: false }
    }
    if (entry.init) return entry.init
    const t0 = Date.now()
    entry.init = (async () => {
      const proc = this.make(directory, "harness", () => {
        log.info("ACP process onDead callback: clearing shared process", {
          key,
          directory,
          harness: this.harnessId(),
        })
        this.invalidateProcess(key, ACP_RECOVER, proc, { dispose: false })
      })
      try {
        await this.initialize(proc)
        entry.proc = proc
        log.info("ACP getOrSpawnProcess: shared process ready", {
          key,
          directory,
          harness: this.harnessId(),
          ms: Date.now() - t0,
        })
        return { proc, isNew: true }
      } catch (err) {
        entry.proc = null
        proc.dispose()
        throw err
      } finally {
        if (entry.init) entry.init = null
      }
    })()
    return entry.init
  }

  private async getOrSpawnProcess(id: string, directory: string): Promise<{ proc: ACPProcess; isNew: boolean }> {
    const key = this.keyForSession(id, directory)
    const entry = this.process(key, directory)
    entry.sessionIds.add(id)
    return this.getOrSpawnProcessForKey(key, directory)
  }

  private entryForSession(id: string) {
    const key = this.sessionProcessMap().get(id) ?? this.store.getSessionOwnerKey?.(id)
    return key ? this.processMap().get(key) : this.legacySessions()?.get(id)
  }

  private async getOrSpawnProbe(directory: string): Promise<ACPProcess> {
    if (this.probe && this.probe.directory !== directory) {
      this.restartProbe()
      this.probe = null
    }
    this.probe ??= {
      directory,
      proc: null,
      init: null,
    }
    this.probe.directory = directory
    const live = this.probe.proc
    if (live?.alive) return live
    if (this.probe.init) return this.probe.init
    const t0 = Date.now()
    this.probe.init = (async () => {
      const proc = this.make(directory, "probe", () => {
        log.info("ACP probe process onDead callback: clearing probe process", {
          directory,
          harness: this.harnessId(),
        })
        if (!this.probe) return
        if (this.probe.proc === proc) this.probe.proc = null
        this.probe.init = null
      })
      try {
        await this.initialize(proc)
        this.probe!.proc = proc
        log.info("ACP probe process ready", {
          directory,
          harness: this.harnessId(),
          ms: Date.now() - t0,
        })
        return proc
      } catch (err) {
        if (this.probe?.proc === proc) this.probe.proc = null
        proc.dispose()
        throw err
      } finally {
        if (this.probe?.init) this.probe.init = null
      }
    })()
    return this.probe.init
  }

  private async boot(
    proc: {
      newSession: (directory: string, title?: string) => Promise<string>
      dispose: () => void
    },
    directory: string,
    title?: string,
    ms = newSessionTimeoutMs(),
  ) {
    let id: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        proc.newSession(directory, title),
        new Promise<string>((_, reject) => {
          id = setTimeout(() => reject(new Error(`ACP newSession timed out after ${ms}ms`)), ms)
        }),
      ])
    } catch (err) {
      log.warn("ACP newSession: failed", {
        directory,
        error: errorMessage(err),
      })
      proc.dispose()
      throw err
    } finally {
      if (id) clearTimeout(id)
    }
  }

  private async initialize(
    proc: {
      initialize: () => Promise<void>
      dispose: () => void
      failureDetail?: () => string
    },
    ms = initializeTimeoutMs(),
  ) {
    let id: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        proc.initialize(),
        new Promise<void>((_, reject) => {
          id = setTimeout(() => reject(new Error(`ACP initialize timed out after ${ms}ms`)), ms)
        }),
      ])
    } catch (err) {
      proc.dispose()
      const message = errorMessage(err)
      const detail = proc.failureDetail?.()
      if (message === "ACP connection closed" && detail) {
        throw new Error(`ACP connection closed: ${detail}`)
      }
      throw err
    } finally {
      if (id) clearTimeout(id)
    }
  }

  private cfg(model?: SessionConfig["model"]) {
    if (model) return model
    if (this.currentModel) {
      return {
        providerID: this.harnessId(),
        modelID: this.currentModel,
      }
    }
    return {
      providerID: this.harnessId(),
      modelID: "default",
    }
  }

  private supportsFork(sessionId?: string) {
    if (sessionId) {
      const entry = this.entryForSession(sessionId)
      if (!entry?.proc?.alive) return false
      return entry.proc.supportsForkSession(this.store.getAgentSessionId(sessionId) ?? undefined)
    }
    for (const entry of this.processEntries()) {
      if (entry.proc?.alive && entry.proc.supportsForkSession()) return true
    }
    return !!this.probe?.proc?.alive && this.probe.proc.supportsForkSession()
  }

  readHarnessCapabilities(_directory?: string, context?: HarnessCapabilityContext): HarnessCapabilities {
    return harnessCapabilities({
      harness: this.harnessId(),
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: false,
      todos: true,
      commands: false,
      fork: this.supportsFork(context?.sessionId),
      revert: false,
      unrevert: false,
      configOptions: true,
      subagents: true,
    })
  }

  async listSessions(directory: string): Promise<AgentSessionRow[]> {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listSessions(directory) as AgentSessionRow[]
  }

  async getSession(id: string, _directory: string): Promise<AgentSessionRow | null> {
    return this.store.getSession(id) as AgentSessionRow | null
  }

  async createSession(directory: string, title?: string, id: string = randomUUID()): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    log.info("createSession: start", { directory, title, binary: this.options.binary })
    if (this.store.getSession(id)) return { id }
    const processKey = this.processKey(directory)
    this.sessionProcessMap().set(id, processKey)
    const { proc } = await this.getOrSpawnProcess(id, directory)
    const agentSessionId = await this.boot(proc, directory, title)
    log.info("createSession: ACP session created", { id, agentSessionId })
    this.store.bindSession({
      sessionId: id,
      directory,
      title,
      agentSessionId,
      ownerKey: processKey,
    })
    this.store.updateSessionConfig(id, {
      harness: {
        id: this.harnessId(),
        access: "acp",
        connection: { kind: "process", binary: this.options.binary },
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
    })
    log.info("createSession: local session stored", { id, agentSessionId })
    return { id }
  }

  async createHandoffSession(directory: string, title: string | undefined, id: string) {
    directory = requireWorkspaceDirectory(directory)
    const processKey = this.processKey(directory)
    this.sessionProcessMap().set(id, processKey)
    const { proc } = await this.getOrSpawnProcess(id, directory)
    const agentSessionId = await this.boot(proc, directory, title)
    this.store.bindSession({ sessionId: id, directory, title, agentSessionId, ownerKey: processKey })
    return { id, agentSessionId, ownerKey: processKey }
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: string): Promise<AgentSessionRow | null> {
    return this.store.updateSession(id, updates) as AgentSessionRow | null
  }

  async getSessionConfig(id: string, _directory: string): Promise<SessionConfig> {
    return this.store.getSessionConfig(id) ?? {
      harness: {
        id: this.harnessId(),
        access: "acp",
        connection: { kind: "process", binary: this.options.binary },
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
    }
  }

  async updateSessionConfig(id: string, update: SessionConfigUpdate, directory: string): Promise<SessionConfig> {
    directory = requireWorkspaceDirectory(directory)
    const previous = this.store.getSessionConfig(id)
    const next = this.store.updateSessionConfig(id, update) ?? await this.getSessionConfig(id, directory)
    try {
      if (next.model?.modelID) {
        this.setModel(next.model.modelID === "default" ? "" : next.model.modelID)
      }
      const proc = this.entryForSession(id)?.proc
      const agentSessionId = this.store.getAgentSessionId(id)
      if (!proc?.alive || !agentSessionId) return next
      await proc.syncSession(agentSessionId, {
        parts: [],
        assistantMessageId: "cfg",
        agent: next.agent ?? "build",
        model: this.cfg(next.model),
        ...(next.variant ? { variant: next.variant } : {}),
      })
      return next
    } catch (error) {
      if (previous) {
        this.store.updateSessionConfig(id, {
          harness: previous.harness,
          model: previous.model ?? null,
          variant: previous.variant ?? null,
          agent: previous.agent ?? null,
          handoff: previous.handoff ?? null,
        })
      }
      throw error
    }
  }

  async deleteSession(id: string, _directory: string): Promise<void> {
    const key = this.sessionProcessMap().get(id) ?? this.store.getSessionOwnerKey?.(id)
    const entry = key ? this.processMap().get(key) : undefined
    entry?.sessionIds.delete(id)
    this.sessionProcessMap().delete(id)
    const persistedSiblings = key
      ? (this.store.listSessionsByOwnerKey?.(key) ?? []).filter((sessionId) => sessionId !== id)
      : []
    if (key && entry && entry.sessionIds.size === 0 && persistedSiblings.length === 0) {
      entry.proc?.dispose()
      this.processMap().delete(key)
    }
    this.store.deleteSession(id)
  }

  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    const t0 = Date.now()
    log.info("sendMessage: start", { id, directory, partCount: input.parts.length })

    const leaveBusy = this.lifecycle().enter(id)
    if (!leaveBusy) {
      log.info("sendMessage: session already busy, rejecting duplicate", { id })
      yield sessionError("Session is already processing a message", id)
      return
    }
    const leaveActivePrompt = enterActivePrompt(this.harnessId())

    try {
      yield* this._sendMessage(id, input, directory, t0)
    } finally {
      leaveActivePrompt()
      leaveBusy()
    }
  }

  async *_sendMessage(id: string, input: PromptInput, directory: string, t0: number): AsyncIterable<AgentRuntimeStreamEvent> {
    const current = this.store.getAgentSessionId(id)
    if (!current) {
      log.error("sendMessage: session not found in DB", { id })
      yield sessionError(`Session ${id} not found`, id)
      return
    }
    let agentSessionId = current
    const session = this.store.getSession(id) as { title?: string | null } | null
    let created = Date.now()
    log.info("sendMessage: found session in store", { id, agentSessionId })
    if (input.model?.modelID) {
      const nextModel = input.model.modelID === "default" ? "" : input.model.modelID
      if ((this.currentModel || "") !== nextModel) this.setModel(nextModel)
    }

    let proc: ACPProcess
    let fresh = false
    try {
      const result = await this.getOrSpawnProcess(id, directory)
      proc = result.proc
      fresh = result.isNew
    } catch (err) {
      log.error("sendMessage: failed to get/spawn ACP process", { err, directory })
      yield sessionError(`Failed to start ACP process: ${err}`, id)
      return
    }
    const processKey = this.sessionProcessMap().get(id) ?? this.keyForSession(id, directory)
    if (this.store.getSessionOwnerKey && this.store.getSessionOwnerKey(id) !== processKey) {
      this.store.bindSession({
        sessionId: id,
        directory,
        title: session?.title ?? undefined,
        agentSessionId,
        ownerKey: processKey,
      })
    }

    log.info("sendMessage: got ACP process, starting prompt", {
      directory,
      binary: this.options.binary,
      agentSessionId,
      msToHere: Date.now() - t0,
    })

    const recover = this.store.consumeRecoveryError(id)
    const start: CompatEvent[] = []
    if (recover) {
      start.push(sessionStatus(id, recovering(recover)))
    } else {
      start.push(sessionStatus(id, { type: "busy" }))
    }
    if (input.userMessageId) {
      start.push(messageUpdated(buildUserMessage({
        id: input.userMessageId,
        sessionID: id,
        agent: input.agent,
        model: input.model,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      })))
    }
    start.push(messageUpdated(buildAssistantMessage({
      id: input.assistantMessageId,
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory,
      created,
    })))
    const committedStart = this.store.startTurn({
      sessionId: id,
      agentSessionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      agent: input.agent,
      model: input.model,
      parts: input.parts,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.system ? { system: input.system } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    })

    const queue: CompatEvent[] = [
      ...(recover ? [start[0]].filter((event) => event !== undefined) : []),
      ...((committedStart?.events ?? start).filter((event) =>
        !recover || event.type !== "session.status"
      )),
    ]
    let promptDone = false
    let promptError: string | null = null
    let promptPromise: Promise<void> = Promise.resolve()
    const resolvers: Array<() => void> = []
    let chunkCount = 0
    let assistantMsgId = input.assistantMessageId
    let drainTurn!: (err: Error) => void
    let drained = false
    const drainPromise = new Promise<never>((_, reject) => {
      drainTurn = reject
    })
    drainPromise.catch(() => {})
    const drain = (message: string) => {
      if (drained) return
      drained = true
      promptError = message
      promptDone = true
      proc.cancel(agentSessionId).catch(() => {})
      this.invalidateProcess(processKey, message, proc)
      for (const r of resolvers.splice(0)) r()
      drainTurn(new Error(message))
    }
    const turn = { drain }
    this.lifecycle().set(id, turn)
    const eventRuntime = createAgentEventRuntime({
      harness: this.harnessId(),
      threadId: agentSessionId,
      adapter: createAcpEventTranslator({ client: this.acpClient() }),
    })

    const push = (event: CompatEvent) => {
      chunkCount++
      log.info("sendMessage: pushing chunk to stream", {
        chunkType: event.type,
        chunkN: chunkCount,
        msFromStart: Date.now() - t0,
      })
      queue.push(event)
      for (const r of resolvers.splice(0)) r()
    }
    const parentProjector = createTurnEventProjector({
      store: this.store,
      owner: {
        sessionId: id,
        getAgentSessionId: () => agentSessionId,
      },
      directory,
      input,
      assistantMessageId: assistantMsgId,
      created,
      onEvent: push,
      onRuntimeEvent: this.options.eventHub?.publishRuntime,
    })
    const router = createChildEventRouter({
      parent: parentProjector,
      createChildProjector: (target) => createTurnEventProjector({
        store: this.store,
        owner: {
          sessionId: target.sessionId,
          getAgentSessionId: target.getAgentSessionId,
        },
        directory,
        input: target.input,
        assistantMessageId: target.assistantMessageId,
        created: target.created,
        onEvent: () => {},
        onRuntimeEvent: this.options.eventHub?.publishRuntime,
      }),
      onDiagnostic: (payload) => this.options.eventHub?.publishRuntime({
        directory,
        sessionId: id,
        agentSessionId,
        assistantMessageId: input.assistantMessageId,
        payload,
      }),
    })
    const admissionStore = this.store.admit && this.store.markPublished
      ? {
          admit: (input: Parameters<NonNullable<AcpRuntimeStore["admit"]>>[0]) => this.store.admit!(input),
          markPublished: (parentSessionId: string, observationId: string) => this.store.markPublished!(parentSessionId, observationId),
        }
      : this.subagentAdmissionStore()
    const subagentAdmission = createSubagentAdmissionBoundary({
      store: admissionStore,
      publish: (parentSessionId, event) => {
        log.info("ACP subagent lifecycle published", {
          parentSessionId,
          subagentKey: event.subagentKey,
          revision: event.revision,
          status: event.status,
        })
        this.options.eventHub?.publishRuntime({
          directory,
          sessionId: parentSessionId,
          agentSessionId,
          assistantMessageId: input.assistantMessageId,
          payload: event,
        })
      },
    })
    const pendingSubagentUpdates = new Set<Promise<void>>()
    const subagentByToolCall = new Map<string, AcpSubagentObservation>()
    const subagentByProviderId = new Map<string, AcpSubagentObservation>()
    const codexStatusByProviderId = new Map<string, { observationId: string; status: NonNullable<AcpSubagentObservation["status"]> }>()
    const childByToolCall = new Map<string, {
      sessionId: string
      agentSessionId: string
      target: ChildProjectionTarget
      started: boolean
      finished: boolean
    }>()
    const childFor = (observation: AcpSubagentObservation) => {
      if (observation.transcript.kind === "none" || this.options.materializeSubagent) return
      const existing = childByToolCall.get(observation.toolCallId)
      if (existing) return existing
      const sessionId = randomUUID()
      const agentSessionId = `unbound:${sessionId}`
      const target = {
        sessionId,
        getAgentSessionId: () => agentSessionId,
        assistantMessageId: randomUUID(),
        created: Date.now(),
        input: {
          userMessageId: randomUUID(),
          agent: input.agent,
          model: input.model,
          ...(input.variant ? { variant: input.variant } : {}),
        },
      } satisfies ChildProjectionTarget
      const child = { sessionId, agentSessionId, target, started: false, finished: false }
      childByToolCall.set(observation.toolCallId, child)
      return child
    }
    const materializeChild = (
      child: NonNullable<ReturnType<typeof childFor>>,
      observation: AcpSubagentObservation,
      correlationKey: string,
    ) => {
      if (!child.started) {
        child.started = true
        this.store.bindSession({
          sessionId: child.sessionId,
          parentSessionId: id,
          directory,
          title: observation.description ?? observation.label ?? "Subagent",
          agentSessionId: child.agentSessionId,
        })
        const parentConfig = this.store.getSessionConfig(id)
        if (parentConfig) this.store.updateSessionConfig(child.sessionId, parentConfig)
        this.store.startTurn({
          sessionId: child.sessionId,
          agentSessionId: child.agentSessionId,
          userMessageId: child.target.input.userMessageId,
          assistantMessageId: child.target.assistantMessageId,
          agent: child.target.input.agent,
          model: child.target.input.model,
          parts: observation.description ? [{ type: "text", text: observation.description }] : [],
          ...(child.target.input.variant ? { variant: child.target.input.variant } : {}),
        })
      }
      router.associate(correlationKey, child.target)
      if (child.finished || !["completed", "failed", "killed", "interrupted"].includes(observation.status ?? "")) return
      child.finished = true
      this.store.finishTurn?.({
        sessionId: child.sessionId,
        assistantMessageId: child.target.assistantMessageId,
        outcome: observation.status === "failed"
          ? { status: "failed", completedAt: Date.now(), error: observation.label ?? "Subagent failed" }
          : observation.status === "completed"
            ? { status: "completed", completedAt: Date.now() }
            : { status: "cancelled", completedAt: Date.now(), reason: observation.status ?? "interrupted" },
      })
    }
    const admitSubagent = (
      observation: AcpSubagentObservation,
      correlationKey: string,
      frame: unknown,
    ) => {
      const child = childFor(observation)
      const admitted = {
        ...observation,
        harnessExecutionId: agentSessionId,
        ...(child ? { childSessionId: child.sessionId } : {}),
      }
      subagentByToolCall.set(observation.toolCallId, observation)
      if (observation.providerId) subagentByProviderId.set(observation.providerId, observation)
      return subagentAdmission.admit(id, admitted).then(async (event) => {
        if (child) {
          materializeChild(child, observation, correlationKey)
          return
        }
        if (event.transcript?.kind === "none") return
        const target = await this.options.materializeSubagent?.({
          parentSessionId: id,
          parentAgentSessionId: agentSessionId,
          directory,
          event,
          prompt: input,
        })
        if (target) router.associate(correlationKey, target)
      }).catch((err) => router.project({
        type: "diagnostic",
        diagnostic: {
          code: "acp_subagent_admission_failed",
          message: errorMessage(err),
          severity: "warn",
          source: "acp-adapter",
        },
      }, {
        dir: "in",
        method: "sessionUpdate.subagent.error",
        frame,
      }))
    }
    const scheduleSubagentUpdate = (update: SessionUpdate) => {
      for (const state of acpCodexCollaborationStates(this.acpClient(), update)) {
        codexStatusByProviderId.set(state.providerId, state)
        const existing = subagentByProviderId.get(state.providerId)
        if (!existing) continue
        const observation = {
          ...existing,
          observationId: state.observationId,
          status: state.status,
        }
        const task = admitSubagent(observation, existing.toolCallId, update)
        pendingSubagentUpdates.add(task)
        void task.finally(() => pendingSubagentUpdates.delete(task))
      }
      const toolCallId = "toolCallId" in update ? update.toolCallId : undefined
      const classified = classifyAcpSubagentUpdate(
        this.acpClient(),
        update,
        toolCallId ? subagentByToolCall.get(toolCallId) : undefined,
      )
      if (!classified || classified.kind === "child") return classified
      const canonical = classified.observation.providerId
        ? codexStatusByProviderId.get(classified.observation.providerId)
        : undefined
      const observation = canonical
        ? { ...classified.observation, observationId: canonical.observationId, status: canonical.status }
        : classified.observation
      log.info("ACP subagent lifecycle observed", {
        toolCallId: observation.toolCallId,
        providerId: observation.providerId,
        status: observation.status,
        observationId: observation.observationId,
      })
      const task = admitSubagent(observation, classified.correlationKey, update)
      pendingSubagentUpdates.add(task)
      void task.finally(() => pendingSubagentUpdates.delete(task))
      return canonical ? { ...classified, observation } : classified
    }

    const wait = () =>
      new Promise<void>((resolve) => {
        if (queue.length > 0 || promptDone) resolve()
        else resolvers.push(resolve)
      })

    const bound = async <T>(label: string, run: Promise<T>, timeoutMs?: number) => {
      let id: ReturnType<typeof setTimeout> | undefined
      const ms = timeoutMs ?? newSessionTimeoutMs()
      try {
        return await Promise.race([
          run,
          drainPromise,
          new Promise<T>((_, reject) => {
            id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          }),
        ])
      } finally {
        if (id) clearTimeout(id)
      }
    }
    const replace = async () => {
      log.info("sendMessage: ACP session missing, creating replacement session", {
        id,
        oldAgentSessionId: agentSessionId,
      })
      agentSessionId = await this.boot(proc, directory, session?.title ?? undefined)
      this.store.bindSession({
        sessionId: id,
        directory,
        title: session?.title ?? undefined,
        agentSessionId,
        ownerKey: this.keyForSession(id, directory),
      })
    }

    try {
      if (fresh) {
        log.info("sendMessage: process is freshly spawned, restoring ACP session", {
          id,
          agentSessionId,
        })
        try {
          await bound("ACP resume", proc.resumeSession(agentSessionId, directory))
        } catch (err) {
          if (!unrestorable(this.harnessId(), err)) throw err
          await replace()
        }
      }
      if (input.permissionMode) {
        const applied = await bound("ACP permission mode", proc.setPermissionMode(agentSessionId, input.permissionMode))
        if (applied.currentModeId !== input.permissionMode) {
          throw new Error(`ACP kept permission mode ${applied.currentModeId ?? "unknown"} instead of ${input.permissionMode}`)
        }
      }
      try {
        await bound("ACP sync", proc.syncSession(agentSessionId, input, { syncMode: false }))
      } catch (err) {
        if (!unrestorable(this.harnessId(), err)) throw err
        await replace()
        await bound("ACP sync", proc.syncSession(agentSessionId, input, { syncMode: false }))
      }
    } catch (err) {
      promptError = errorMessage(err)
      proc.cancel(agentSessionId).catch(() => {})
      this.invalidateProcess(processKey, promptError, proc)
      promptDone = true
      for (const r of resolvers.splice(0)) r()
    }

    if (!promptError) {
      const observesLifecycle = typeof proc.observeSession === "function"
      const projectUpdate = (
        update: SessionUpdate,
        subagent: ReturnType<typeof scheduleSubagentUpdate>,
        project: typeof router.project,
      ) => {
        const result = eventRuntime.ingest({
          source: "acp.jsonrpc",
          method: "session/update",
          payload: update,
        })
        for (const runtimeEvent of result.events) {
          project(runtimeEvent, {
            dir: "in",
            method: "sessionUpdate",
            frame: update,
          }, subagent?.kind === "child"
            ? { kind: "child", correlationKey: subagent.correlationKey }
            : { kind: "parent" })
          if (subagent?.kind === "child" || runtimeEvent.type !== "step-start") continue
          assistantMsgId = router.assistantMessageId()
          created = router.created()
        }
      }
      const forward = (update: SessionUpdate) => {
        const subagent = scheduleSubagentUpdate(update)
        projectUpdate(update, subagent, router.project)
      }
      const observeLateSubagentUpdate = (update: SessionUpdate) => {
        const toolCallId = "toolCallId" in update ? update.toolCallId : undefined
        if (!toolCallId || !subagentByToolCall.has(toolCallId)) return
        const subagent = scheduleSubagentUpdate(update)
        if (!subagent || subagent.kind === "child") return
        // A canonical terminal tool frame may follow the ACP prompt response.
        // Persist it through the still-authoritative parent projector so the
        // host does not later terminalize the already-completed tool as an
        // interruption. The child router is intentionally not used here: its
        // correlation buffers are turn-scoped and may already be disposed.
        projectUpdate(update, subagent, (runtimeEvent, source) => parentProjector.project(runtimeEvent, source))
      }
      const install = () => {
        proc.permissionPushers.set(agentSessionId, ({ permId, tool, kind, paths }) => {
          log.info("sendMessage: forwarding permission-request to stream", { permId, tool, kind })
          this.permissionOwnerMap().set(permId, proc)
          const event = permissionAsked(
            acpPermissionRequest({ permId, sessionId: id, tool, kind, paths }),
          )
          this.store.appendEvent({
            sessionId: id,
            agentSessionId,
            payload: event,
            source: {
              dir: "in",
              method: "requestPermission",
              frame: { tool, paths },
            },
          })
          push(event)
        })
      }
      const stop = (stopReason: StopReason) => {
        log.info("sendMessage: prompt resolved", { stopReason, ms: Date.now() - t0 })
        for (const runtimeEvent of translateStopReason(stopReason as Parameters<typeof translateStopReason>[0], id)) {
          router.project(runtimeEvent, {
            dir: "in",
            method: "prompt.stop",
            frame: { stopReason },
          })
        }
      }
      let retried = false
      const run = async (): Promise<void> => {
        install()
        if (observesLifecycle) proc.observeSession(agentSessionId, observeLateSubagentUpdate)
        try {
          // The PROMPT turn runs for as long as the model thinks/streams — it
          // must use the prompt timeout (5 min default), NOT the 10s
          // new-session handshake timeout, which cancelled every turn slower
          // than 10s (codex with reasoning models never survived it).
          const result = await bound("ACP prompt", proc.prompt(agentSessionId, input, forward), promptTimeoutMs())
          // Prompt-result usage is the ONLY meterable usage on this rail:
          // mid-turn `usage_update` notifications carry a context meter, not
          // token categories. Semantics verified against the pinned agents:
          // claude-agent-acp returns per-turn usage (its accumulator resets on
          // turn activation); codex-acp returns only the LAST API request's
          // usage, so its multi-request turns undercount until fixed upstream.
          const usableUsage = result.usage && (
            result.usage.totalTokens > 0 ||
            result.usage.inputTokens > 0 ||
            result.usage.outputTokens > 0 ||
            (result.usage.thoughtTokens ?? 0) > 0 ||
            (result.usage.cachedReadTokens ?? 0) > 0 ||
            (result.usage.cachedWriteTokens ?? 0) > 0
          )
          if (!usableUsage && (result.stopReason === "end_turn" || result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests")) {
            // A completed turn with no usage silently settles "unavailable" in
            // the usage ledger. That is a metering gap, not a normal outcome —
            // make it loud so zero-token dashboards are diagnosable.
            router.project({
              type: "diagnostic",
              diagnostic: {
                code: "acp_prompt_usage_missing",
                message: `ACP agent returned no token usage for a completed turn (stopReason: ${result.stopReason}); the turn meters as unavailable`,
                severity: "warn",
                source: "acp-adapter",
              },
            }, {
              dir: "in",
              method: "prompt.result.usage",
              frame: { stopReason: result.stopReason },
            })
          }
          if (result.usage && usableUsage) {
            router.project(runtimeUsage(result.usage, agentSessionId), {
              dir: "in",
              method: "prompt.result.usage",
              frame: { usage: result.usage },
            })
            const event = messageUpdated({
              ...buildAssistantMessage({
                id: assistantMsgId,
                sessionID: id,
                parentID: input.userMessageId ?? id,
                agent: input.agent,
                model: input.model,
                directory,
                created,
                completed: Date.now(),
                variant: input.variant,
              }),
              tokens: messageUsage(result.usage),
            })
            this.store.appendEvent({
              sessionId: id,
              agentSessionId,
              payload: event,
              source: {
                dir: "in",
                method: "prompt.result",
                frame: { usage: result.usage },
              },
            })
            push(event)
          }
          stop(result.stopReason)
        } catch (err) {
          proc.permissionPushers.delete(agentSessionId)
          if (retried || !missing(err)) throw err
          retried = true
          await replace()
          await bound("ACP sync", proc.syncSession(agentSessionId, input, { syncMode: false }))
          return run()
        }
      }
      promptPromise = Promise.race([run(), drainPromise])
      .catch((err: unknown) => {
        log.error("sendMessage: prompt rejected", { err, ms: Date.now() - t0 })
        promptError = errorMessage(err)
        proc.cancel(agentSessionId).catch(() => {})
        this.invalidateProcess(processKey, promptError, proc)
      })
      .finally(() => {
        proc.permissionPushers.delete(agentSessionId)
        promptDone = true
        for (const r of resolvers.splice(0)) r()
      })
    }

    let titleEmitted = false
    try {
      while (true) {
        await wait()
        let event: CompatEvent | undefined
        while ((event = queue.shift())) {
          // Before yielding session.idle, emit auto-title if needed
          if (event.type === "session.idle" && !titleEmitted) {
            titleEmitted = true
            const titleEvent = maybeAutoTitle({
              store: this.store,
              eventHub: this.options.eventHub,
              getOrSpawnProcess: (sessionId, workdir) => this.getOrSpawnProcess(sessionId, workdir),
              boot: (proc, workdir, title) => this.boot(proc, workdir, title),
            }, id, agentSessionId, directory, input.parts)
            if (titleEvent) yield titleEvent
          }
          yield event
          if (isTerminalCompatEvent(event)) {
            log.info("sendMessage: terminal chunk yielded, returning", {
              chunkType: event.type,
              totalChunks: chunkCount,
              ms: Date.now() - t0,
            })
          }
        }
        if (promptDone) break
      }
    } finally {
      await promptPromise
      await Promise.allSettled([...pendingSubagentUpdates])
      router.dispose()
      this.lifecycle().delete(id, turn)
    }

    if (promptError) {
      log.error("sendMessage: ending with error", { promptError, ms: Date.now() - t0 })
      for (const event of router.terminalizeParent(promptError, {
        dir: "in",
        method: "prompt.error.open-tools",
        frame: { message: promptError },
      })) yield event
      const updated = messageUpdated(buildAssistantMessage({
        id: assistantMsgId,
        sessionID: id,
        parentID: input.userMessageId ?? id,
        agent: input.agent,
        model: input.model,
        directory,
        created,
        completed: Date.now(),
        error: {
          name: "UnknownError",
          data: firstTurnErrorData(promptError),
        },
        variant: input.variant,
      }))
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: updated,
        source: {
          dir: "in",
          method: "prompt.error",
          frame: { message: promptError },
        },
      })
      yield updated
      const event = sessionError(promptError, id)
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: event,
        source: {
          dir: "in",
          method: "prompt.error",
          frame: { message: promptError },
        },
      })
      yield event
      return
    }

    log.info("sendMessage: finished successfully", { totalChunks: chunkCount, ms: Date.now() - t0 })
  }

  async getMessages(id: string, _directory: string): Promise<AgentMessageRow[]> {
    return this.store.getMessages(id) as AgentMessageRow[]
  }

  async abort(id: string, directory: string): Promise<AbortResult> {
    directory = requireWorkspaceDirectory(directory)
    log.info("abort: called", { id, directory })
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!agentSessionId) {
      log.info("abort: session not found in store", { id })
      this.store.markSessionInterrupted(id, "ACP session could not be cancelled because no agent session is attached.")
      return {
        ok: false,
        status: "recovering",
        message: "ACP session could not be cancelled because no agent session is attached.",
      }
    }
    const proc = this.entryForSession(id)?.proc
    if (!proc?.alive) {
      log.info("abort: no alive process for session", { id, directory })
      this.store.markSessionInterrupted(id, "ACP session could not be cancelled because its process is no longer alive.", agentSessionId)
      return {
        ok: false,
        status: "recovering",
        message: "ACP session could not be cancelled because its process is no longer alive.",
      }
    }
    try {
      await proc.cancel(agentSessionId)
      return { ok: true, status: "cancelled" }
    } catch (err) {
      log.info("abort: cancel failed; disposing session process", { id, directory, err })
      const key = this.sessionProcessMap().get(id) ?? this.store.getSessionOwnerKey?.(id) ?? this.processKey(directory)
      this.invalidateProcess(key, "ACP session cancellation failed; the agent process was stopped.", proc)
      return {
        ok: false,
        status: "recovering",
        message: "ACP session cancellation failed; the agent process was stopped.",
      }
    }
  }

  async forkSession(id: string, _messageId: string, directory: string, childSessionId?: string): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    log.info("forkSession: called", { id, directory })
    const row = this.getSession(id, directory) as Promise<{ agent_session_id?: string; title?: string | null } | null>
    const session = await row
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!session || !agentSessionId) throw new Error(`Session ${id} not found`)

    const result = await this.getOrSpawnProcess(id, directory)
    const proc = result.proc
    if (result.isNew) {
      await proc.resumeSession(agentSessionId, directory)
    }
    if (!proc.supportsForkSession(agentSessionId)) {
      throw new Error("ACP agent does not advertise session fork support")
    }
    const newAgentSessionId = await proc.forkSession(agentSessionId, directory)
    log.info("forkSession: ACP fork succeeded", { newAgentSessionId })

    const newId = childSessionId ?? randomUUID()
    const processKey = this.sessionProcessMap().get(id)
      ?? this.store.getSessionOwnerKey?.(id)
      ?? (this.options ? this.keyForSession(id, directory) : null)
    if (processKey) {
      this.sessionProcessMap().set(newId, processKey)
      this.process(processKey, directory).sessionIds.add(newId)
    }
    this.store.bindSession({
      sessionId: newId,
      directory,
      title: session.title ?? undefined,
      agentSessionId: newAgentSessionId,
      ...(processKey ? { ownerKey: processKey } : {}),
    })
    log.info("forkSession: done", { newId, newAgentSessionId })
    return { id: newId }
  }

  async listCommands(_directory: string): Promise<AgentCommandRow[]> {
    return listCommands()
  }

  async listAgents(directory: string): Promise<AgentAgentRow[]> {
    directory = requireWorkspaceDirectory(directory)
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (!proc?.alive) continue
      const list = proc.getAgents()
      if (list.length > 0) return list
    }
    const probe = this.probe?.proc
    if (probe?.alive) {
      const list = probe.getAgents()
      if (list.length > 0) return list
    }
    const cfg = await this.probeConfigOptions(directory)
    if (Array.isArray(cfg) && cfg.length > 0) {
      const list = extractAgents({
        caps: null,
        prompt: null,
        cfg: cfg as SessionConfigOption[],
        modes: [],
      })
      if (list.length > 0) return list
    }
    throw new Error("ACP harness did not return live agent options")
  }

  /**
   * Permission modes for a Claxedo session.
   *
   * Two things must both be true before an agent can answer: it has to have been
   * booted (so there is a process) and a `session/new` must have happened (so
   * there is an agent session id whose state holds the advertised modes). Before
   * that this reports NO modes and NO `unsupported` — the caller renders that as
   * "not reported yet", which is the truth, rather than as "this agent has none".
   */
  async listPermissionModes(sessionId: string, directory: string): Promise<AgentPermissionModeState> {
    directory = requireWorkspaceDirectory(directory)
    const agentSessionId = this.store.getAgentSessionId(sessionId)
    const proc = this.entryForSession(sessionId)?.proc
    // No agent session yet: show what this agent version is KNOWN to offer, by
    // its own ids and names, so the draft choice survives the first message
    // unchanged. An agent we have never probed reports nothing rather than a
    // plausible-looking guess.
    if (!agentSessionId || !proc?.alive) return draftPermissionModes(this.harnessId())
    const state = proc.permissionModes(agentSessionId)
    // Teach later drafts what this user's agent actually offers, so the recorded
    // seed stops being consulted for a build it may not describe.
    rememberLiveModes(this.harnessId(), state)
    return state
  }

  async setPermissionMode(sessionId: string, modeId: string, directory: string): Promise<AgentPermissionModeState> {
    directory = requireWorkspaceDirectory(directory)
    const agentSessionId = this.store.getAgentSessionId(sessionId)
    const proc = this.entryForSession(sessionId)?.proc
    // Deliberately a THROW rather than a silent no-op: a permission write that
    // quietly does nothing is the exact failure this whole channel exists to
    // prevent, and the caller surfaces it.
    if (!agentSessionId || !proc?.alive) {
      throw new Error("ACP session has no live agent session to set a permission mode on")
    }
    return proc.setPermissionMode(agentSessionId, modeId)
  }

  async getTodos(sessionId: string, _directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    return this.store.getTodos(sessionId)
  }

  async listPermissions(directory: string): Promise<AgentPermissionRow[]> {
    directory = requireWorkspaceDirectory(directory)
    const rows = this.store.listPermissions(directory)
    const live = rows.filter((row) => {
      const proc = this.permissionProcess(row.id, row.sessionID)
      if (proc?.alive && proc.pendingPermissions.has(row.id)) return true
      this.permissionOwnerMap().delete(row.id)
      return false
    })
    log.info("listPermissions", { count: rows.length, live: live.length })
    return live as AgentPermissionRow[]
  }

  async respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): Promise<AgentInteractionResult | void> {
    directory = requireWorkspaceDirectory(directory)
    log.info("respondPermission: called", { permId, decision, directory })
    const row = (this.store.listPermissions(directory) as Array<{ id: string; sessionID: string }>).find((item) => item.id === permId)
    const clear = () => {
      this.permissionOwnerMap().delete(permId)
      if (!row) return
      const committed = this.store.appendEvent({
        sessionId: row.sessionID,
        payload: permissionReplied(
          row.sessionID,
          permId,
          decision === "allow_always" ? "always" : decision === "allow_once" ? "once" : "reject",
        ),
        source: {
          dir: "out",
          method: "permission.reply",
          frame: { decision },
        },
      })
      return committed?.payload ? { events: [committed.payload] } : undefined
    }
    const proc = row ? this.permissionProcess(permId, row.sessionID) : undefined
    if (!proc?.alive) {
      log.info("respondPermission: no alive process for permission session", {
        directory,
        permId,
        sessionId: row?.sessionID,
      })
      return clear()
    }
    const pending = proc.pendingPermissions.get(permId)
    if (!pending) {
      log.info("respondPermission: permId not found in pending map", {
        permId,
        knownPermIds: [...proc.pendingPermissions.keys()],
      })
      return clear()
    }
    const preferred = permissionOptionPreference(decision)
    const option = selectPermissionOption(decision, pending.options)
    if (option) {
      log.info("respondPermission: resolving with option", {
        permId,
        decision,
        requestedKind: preferred[0],
        selectedOptionId: option.optionId,
        selectedKind: option.kind,
        // Loud when we had to settle for something other than first choice.
        degraded: option.kind !== preferred[0],
      })
      proc.respondPermission(permId, { outcome: { outcome: "selected", optionId: option.optionId } })
      return clear()
    }
    log.info("respondPermission: no acceptable option found in pending.options", {
      permId,
      decision,
      preferred,
      availableKinds: pending.options.map((o) => o.kind),
    })
    proc.respondPermission(permId, { outcome: { outcome: "cancelled" } })
    return clear()
  }

  private permissionProcess(permId: string, sessionId: string) {
    const owner = this.permissionOwnerMap().get(permId)
    if (owner?.alive && owner.pendingPermissions.has(permId)) return owner
    const bound = this.entryForSession(sessionId)?.proc
    if (bound?.alive && bound.pendingPermissions.has(permId)) return bound
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (proc?.alive && proc.pendingPermissions.has(permId)) return proc
    }
  }

  // The field is initialized at declaration, but test harnesses build the
  // adapter via Object.create(AcpHarnessAdapter.prototype), which skips class field
  // initializers — lazily ensure the map exists before use.
  private permissionOwnerMap() {
    this.permissionOwners ??= new Map<string, ACPProcess>()
    return this.permissionOwners
  }

  async applyConfig(config: Record<string, unknown>): Promise<void> {
    const mcp = config.mcp as Record<string, ResolvedMcpServer> | undefined
    // Gating here keeps `currentMcp` empty for the whole adapter lifetime:
    // session requests, process fingerprints, restart decisions, and process
    // observation all read it, so nothing downstream needs its own check.
    const nextMcp = this.options.supportsMcpServers === false ? [] : toAcpMcpServers(mcp ?? {})
    const nextEnv = mergeAcpEnv(this.currentEnv, envFromConfig(config))
    const unchanged = sameAcpMcp(this.currentMcp, nextMcp) && sameAcpEnv(this.currentEnv, nextEnv)
    if (unchanged && !this.configRestartPending) {
      log.info("ACP config apply skipped restart because effective config is unchanged", {
        keys: Object.keys(config),
        harness: this.harnessId(),
        binary: this.options.binary,
      })
      return
    }
    if (this.lifecycle().activeTurns.size > 0 || activePromptCount(this.harnessId()) > 0) {
      this.currentMcp = nextMcp
      this.currentEnv = nextEnv
      this.configRestartPending = true
      log.info("ACP config apply deferred restart because a prompt is active", {
        keys: Object.keys(config),
        harness: this.harnessId(),
        binary: this.options.binary,
      })
      return
    }
    this.currentMcp = nextMcp
    this.currentEnv = nextEnv
    this.configRestartPending = false
    this.restart()
    this.forgetSessionProcessBindings()
    log.info("Applied config in-memory, restarted ACP process", {
      keys: Object.keys(config),
      harness: this.harnessId(),
      binary: this.options.binary,
    })
  }

  async waitForConfigReady(): Promise<void> {
    while (this.configRestartPending && activePromptCount(this.harnessId()) > 0) {
      await waitForNoActivePrompts(this.harnessId())
    }
    if (!this.configRestartPending) return
    this.configRestartPending = false
    this.restart()
    this.forgetSessionProcessBindings()
    log.info("Applied deferred ACP config after active prompts completed", {
      harness: this.harnessId(),
      binary: this.options.binary,
    })
  }

  peekConfigOptions(_directory: string): AgentConfigOptionRow[] | null {
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (proc?.alive && proc.cachedConfigOptions) return proc.cachedConfigOptions as AgentConfigOptionRow[]
    }
    const proc = this.probe?.proc
    if (proc?.alive && proc.cachedConfigOptions) return proc.cachedConfigOptions as AgentConfigOptionRow[]
    return null
  }

  async probeConfigOptions(directory: string): Promise<AgentConfigOptionRow[]> {
    directory = requireWorkspaceDirectory(directory)
    const live = this.peekConfigOptions(directory)
    if (live) {
      log.info("probeConfigOptions: returning cached options from existing process")
      return live
    }
    if (activePromptCount(this.harnessId()) > 0) {
      throw new Error("ACP harness config options are temporarily unavailable while a prompt is active")
    }
    const wait = async <T>(label: string, run: Promise<T>) => {
      const ms = probeTimeoutMs()
      let id: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          run,
          new Promise<T>((_, reject) => {
            id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          }),
        ])
      } finally {
        if (id) clearTimeout(id)
      }
    }
    try {
      const proc = await wait("ACP mode probe", this.getOrSpawnProbe(directory))
      if (proc.cachedConfigOptions) return proc.cachedConfigOptions as AgentConfigOptionRow[]
      await this.boot(proc, directory, undefined, probeTimeoutMs())
      if (!proc.cachedConfigOptions) {
        const ms = probeTimeoutMs()
        await wait("ACP mode cache", new Promise<void>((resolve) => {
          let check: ReturnType<typeof setInterval> | undefined
          const done = () => {
            clearTimeout(timeout)
            if (check) clearInterval(check)
            resolve()
          }
          const timeout = setTimeout(done, ms)
          check = setInterval(() => {
            if (proc.cachedConfigOptions) {
              done()
            }
          }, 100)
        }))
      }
      if (!proc.cachedConfigOptions) throw new Error("ACP harness did not return live config options")
      return proc.cachedConfigOptions as AgentConfigOptionRow[]
    } catch (err) {
      log.warn("probeConfigOptions: failed", {
        directory,
        error: errorMessage(err),
      })
      throw err
    }
  }

  readRuntimeHealth(directory: string): AgentHarnessAdapterHealth {
    directory = requireWorkspaceDirectory(directory)
    const recovering = (this.store.listSessions(directory) as Array<{
      id: string
      status?: string | null
      recovery_error?: string | null
    }>).filter((session) => session.status === "recovering")
    if (recovering.length > 0) {
      return {
        status: "degraded",
        reason: "harness_process_lost",
        message: recovering[0]?.recovery_error ?? "ACP session process restarted",
        sessions: recovering.map((session) => ({
          id: session.id,
          status: session.status,
          message: session.recovery_error ?? null,
        })),
      }
    }
    return { status: "ok" }
  }

  dispose(): void {
    log.info("AcpHarnessAdapter dispose: disposing ACP processes", {
      processes: this.processMap().size,
      harness: this.harnessId(),
      binary: this.options.binary,
    })
    this.restart()
    this.processMap().clear()
    this.sessionProcessMap().clear()
    this.probe = null
    this.closeStore()
  }
}
