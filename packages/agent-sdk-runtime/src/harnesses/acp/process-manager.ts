import type { AgentSessionStartBinding, ConnectionRuntimeStatus } from "@claxedo/agent-runtime-contract"
import { createHash, randomUUID } from "crypto"
import type { McpServer } from "@agentclientprotocol/sdk"
import { Log } from "../../log"
import { acpFirstPartyMcpServer, type FirstPartyMcpProvider } from "../../first-party-mcp"
import { ACP_RECOVER } from "./recovery"
import type { RetirementResult } from "../../launch"
import { ACPProcess } from "./process"
import { createACPConnectionObservations, type ACPConnectionObservationUpdate } from "./connection-state"
import { createSessionTurnLifecycle, type SessionTurnLifecycle } from "../shared/turn-lifecycle"
import {
  acpTransportRetirementBlockers,
  createACPTransportFactory,
  fencedRetirement,
  validateACPConnection,
  waitForACPTransportRetirement,
  type ACPConnection,
  type ACPTransportEnv,
} from "./transport"
import {
  errorMessage,
  initializeTimeoutMs,
  mergeAcpEnv,
  newSessionTimeoutMs,
  sameAcpEnv,
} from "./helpers"
import {
  observeAgentProcess,
  type AgentProcessObserverHandle,
} from "../../process-observer"
import type { AcpHarnessAdapterOptions, AcpRuntimeStore } from "./index"

const log = Log.create({ service: "acp-process-manager" })

type ACPProcessKey = string
type ProcEntry = {
  key: ACPProcessKey
  directory: string
  proc: ACPProcess | null
  init: Promise<{ proc: ACPProcess; isNew: boolean }> | null
  starting?: AbortController
  startingProc?: ACPProcess
  sessionIds: Set<string>
  fork?: boolean
  subagents?: boolean
}
type ProbeEntry = {
  directory: string
  proc: ACPProcess | null
  init: Promise<ACPProcess> | null
}
export type ActiveAcpTurn = { drain(message: string): void }

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

function processFingerprint(input: unknown) {
  return `acp:${createHash("sha256").update(JSON.stringify(stable(input))).digest("hex")}`
}

function executableBasename(input: string) {
  return input.split(/[\\/]/).at(-1) || "agent"
}

function missingStore(): AcpRuntimeStore {
  throw new Error("AcpHarnessAdapter requires a runtime store from the host")
}

export abstract class AcpProcessManager {
  protected store: AcpRuntimeStore
  protected ownsStore = false
  protected storeClosed = false
  protected currentModel = ""
  protected currentEnv: ACPTransportEnv = {}
  protected currentMcp: McpServer[] = []
  protected firstPartyMcp: FirstPartyMcpProvider | undefined
  protected turnLifecycle = createSessionTurnLifecycle<ActiveAcpTurn>()
  protected processes = new Map<ACPProcessKey, ProcEntry>()
  protected sessionProcesses = new Map<string, ACPProcessKey>()
  protected ignoreStoredProcessKeys = false
  protected permissionOwners = new Map<string, ACPProcess>()
  protected probe: ProbeEntry | null = null
  protected configRestartPending = false
  private connectionConfig?: ACPConnection
  private observedConnections?: ReturnType<typeof createACPConnectionObservations>
  private connectionUpdates?: WeakMap<object, (update: ACPConnectionObservationUpdate) => void>

  constructor(protected readonly options: AcpHarnessAdapterOptions) {
    this.connectionConfig = validateACPConnection(options.connection)
    const connection = this.connection()
    this.store = options.store ?? options.createStore?.(options.storeRoot) ?? missingStore()
    this.ownsStore = !options.store
    this.currentEnv = connection.kind === "process" ? { ...connection.env } : {}
  }

  readConnectionState(directory: string, context?: { sessionId?: string }): ConnectionRuntimeStatus {
    const key = context?.sessionId ? this.sessionOwnerKey(context.sessionId) ?? (this.ignoreStoredProcessKeys ? this.processKey(directory) : "unobserved-session") : undefined
    return this.observedConnections?.read(directory, key) ?? { state: "configured", processes: [] }
  }

  protected connection(): ACPConnection {
    this.connectionConfig ??= validateACPConnection(this.options.connection)
    return this.connectionConfig
  }

  private processCommand() {
    const connection = this.connection()
    return connection.kind === "process" ? connection.command : undefined
  }

  private processArgs() {
    const connection = this.connection()
    return connection.kind === "process" ? connection.args ?? [] : []
  }

  protected harnessId(): string {
    return this.options.harness
  }

  protected lifecycle(): SessionTurnLifecycle<ActiveAcpTurn> {
    this.turnLifecycle ??= createSessionTurnLifecycle<ActiveAcpTurn>()
    return this.turnLifecycle
  }

  protected processMap() {
    this.processes ??= new Map<ACPProcessKey, ProcEntry>()
    return this.processes
  }

  protected sessionProcessMap() {
    this.sessionProcesses ??= new Map<string, ACPProcessKey>()
    return this.sessionProcesses
  }

  protected processEntries(): Iterable<{ proc?: ACPProcess | null }> {
    return this.processMap().values()
  }

  protected supportsForkCapability(sessionId?: string) {
    if (sessionId) {
      const entry = this.entryForSession(sessionId)
      if (!entry?.proc?.alive) return entry?.fork ?? false
      return entry.proc.supportsForkSession(this.store.getAgentSessionId(sessionId) ?? undefined)
    }
    for (const entry of this.processEntries()) {
      if (entry.proc?.alive && entry.proc.supportsForkSession()) return true
    }
    return !!this.probe?.proc?.alive && this.probe.proc.supportsForkSession()
  }

  protected supportsSubagentCapability(sessionId?: string) {
    if (sessionId) {
      const entry = this.entryForSession(sessionId)
      return entry?.proc?.alive ? entry.proc.supportsSubagents() : entry?.subagents ?? false
    }
    for (const entry of this.processEntries()) {
      if (entry.proc?.alive && entry.proc.supportsSubagents()) return true
    }
    return !!this.probe?.proc?.alive && this.probe.proc.supportsSubagents()
  }

  protected supportsGoalCapability(sessionId?: string) {
    const available = (proc?: ACPProcess | null) => !!proc?.alive && proc.goalCapabilities().available
    if (sessionId) return available(this.entryForSession(sessionId)?.proc)
    for (const entry of this.processEntries()) {
      if (available(entry.proc)) return true
    }
    return false
  }

  protected processKey(directory: string): ACPProcessKey {
    const options = this.options
    return processFingerprint({
      harness: this.harnessId(),
      access: "connection",
      directory,
      command: this.processCommand(),
      args: this.processArgs(),
      transport: options.createTransport ? "custom" : this.connection().kind,
      env: this.currentEnv ?? {},
      mcp: this.currentMcp ?? [],
    })
  }

  private sessionOwnerKey(id: string) {
    return this.sessionProcessMap().get(id) ?? (this.ignoreStoredProcessKeys ? undefined : this.store.getSessionOwnerKey?.(id))
  }

  protected keyForSession(id: string, directory: string): ACPProcessKey {
    const key = this.sessionOwnerKey(id) ?? this.processKey(directory)
    this.sessionProcessMap().set(id, key)
    return key
  }

  protected process(key: ACPProcessKey, directory: string) {
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

  protected forgetSessionProcessBindings() {
    this.sessionProcessMap().clear()
    this.ignoreStoredProcessKeys = true
  }

  protected invalidateProcess(
    key: ACPProcessKey,
    message = ACP_RECOVER,
    proc?: ACPProcess | null,
    options?: { dispose?: boolean; recover?: boolean },
  ) {
    const entry = this.processMap().get(key)
    const target = proc ?? entry?.proc ?? null
    // A late close callback from a replaced process cannot invalidate its successor.
    if (target && entry?.proc && entry.proc !== target) return
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
      if (options?.dispose !== false) fencedRetirement(target.dispose(message))
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

  /**
   * The replacement cannot start until these settle: `getOrSpawnProcessForKey`
   * waits on the same fence, and an unresolved retirement keeps it closed
   * rather than letting a second writer open the agent's session storage.
   */
  protected restartProcess(key: ACPProcessKey): Promise<RetirementResult | undefined>[] {
    const entry = this.processMap().get(key)
    for (const id of entry?.sessionIds ?? []) {
      this.lifecycle().drain(id, "ACP session process restarted")
    }
    entry?.starting?.abort()
    const retirements = [entry?.startingProc?.dispose(), entry?.proc?.dispose()].filter((item) => !!item)
    if (!entry) return retirements
    entry.starting = undefined
    entry.startingProc = undefined
    entry.proc = null
    entry.init = null
    delete entry.fork
    delete entry.subagents
    return retirements
  }

  /** Launches this manager never established as stopped, read under the key it fences them by. */
  protected retirementBlockers(): readonly RetirementResult[] {
    return acpTransportRetirementBlockers(root(), this.connection())
  }

  protected restartProbe(): Promise<RetirementResult | undefined>[] {
    const retirement = this.probe?.proc?.dispose()
    if (!this.probe) return retirement ? [retirement] : []
    this.probe.proc = null
    this.probe.init = null
    return retirement ? [retirement] : []
  }

  protected restart(): Promise<RetirementResult | undefined>[] {
    this.lifecycle().drainAll("ACP session process restarted")
    const retirements = [...this.processMap().keys()].flatMap((key) => this.restartProcess(key))
    return [...retirements, ...this.restartProbe()]
  }

  protected closeStore() {
    if (!this.ownsStore || this.storeClosed) return
    this.storeClosed = true
    this.store.close?.()
  }

  setModel(model: string): void {
    // The runtime sets the default for newly created sessions here. Existing
    // sessions apply their own model through session/set_config_option.
    this.currentModel = model
  }

  setAuth(keys: ACPTransportEnv): void {
    const next = mergeAcpEnv(this.currentEnv, keys)
    if (sameAcpEnv(this.currentEnv, next)) return
    if (this.lifecycle().activeTurns.size > 0) {
      throw new Error("ACP process config cannot change while a prompt is active")
    }
    this.currentEnv = next
    fencedRetirement(this.restart())
    this.forgetSessionProcessBindings()
    log.info("ACP env updated, ACP session processes disposed", {
      harness: this.harnessId(),
      command: this.processCommand(),
    })
  }

  protected make(directory: string, role: "harness" | "probe", dead: () => void = () => {}, key = role === "probe" ? "probe" : this.processKey(directory)) {
    const launch = { args: this.processArgs(), env: this.currentEnv }
    const ownerId = `acp-${role}:${randomUUID()}`
    const launchId = randomUUID()
    this.observedConnections ??= createACPConnectionObservations()
    const update = this.observedConnections.begin(key, directory, role === "harness" ? "execution" : "discovery")
    try {
      const proc = new ACPProcess(
        root(),
        this.processCommand(),
        launch.args,
        this.currentModel,
        // Deliberately outside `processKey`'s fingerprint: the entry differs per
        // session and its bearer is re-read at every launch, so folding it in
        // would fork one process per session and restart them on a refresh.
        (sessionId) => [
          ...this.currentMcp,
          ...(sessionId && this.firstPartyMcp ? [acpFirstPartyMcpServer(this.firstPartyMcp.server(sessionId))] : []),
        ],
        dead,
        this.options.createTransport ?? createACPTransportFactory(this.connection()),
        () => launch.env,
        (transport) => this.observeProcess({
          directory,
          launchId,
          ownerId,
          role,
          transport,
        }),
        update,
      )
      this.connectionUpdates ??= new WeakMap()
      this.connectionUpdates.set(proc, update)
      return proc
    } catch (error) {
      update({ state: "failed", reason: "transport_launch_failed" })
      throw error
    }
  }

  protected observeProcess(input: {
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
        access: "connection",
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
        ...(local && this.processCommand() ? { executableBasename: executableBasename(this.processCommand()!) } : {}),
        transport: input.transport.kind,
      }),
      ...this.currentMcp.map((server) => observeAgentProcess(this.options.processObserver, {
        ownerId: `acp-mcp:${randomUUID()}`,
        launchId: randomUUID(),
        harnessId: this.harnessId(),
        access: "connection",
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

  protected async getOrSpawnProcessForKey(key: ACPProcessKey, directory: string, owner?: AgentSessionStartBinding, signal?: AbortSignal): Promise<{ proc: ACPProcess; isNew: boolean }> {
    if (owner && owner.directory !== directory) throw new Error("Session start directory mismatch")
    const entry = this.process(key, directory)
    const live = entry.proc
    if (live?.alive) {
      this.observedConnections?.associate(key, directory)
      log.info("ACP getOrSpawnProcess: reusing shared process", {
        key,
        directory,
        sessions: entry.sessionIds.size,
        harness: this.harnessId(),
      })
      return { proc: live, isNew: false }
    }
    if (entry.init) {
      if (owner) throw new Error("Connection initialization is already owned by another operation")
      const result = await entry.init
      this.observedConnections?.associate(key, directory)
      return result
    }
    const t0 = Date.now()
    const starting = new AbortController()
    entry.starting = starting
    const operationSignal = signal ? AbortSignal.any([signal, starting.signal]) : starting.signal
    entry.init = (async () => {
      await waitForACPTransportRetirement(root(), this.connection())
      if (operationSignal.aborted) throw new Error("Connection initialization cancelled")
      const proc = this.make(directory, "harness", () => {
        log.info("ACP process onDead callback: clearing shared process", {
          key,
          directory,
          harness: this.harnessId(),
        })
        this.invalidateProcess(key, ACP_RECOVER, proc, { dispose: false })
      }, key)
      entry.startingProc = proc
      try {
        await this.initialize(proc, undefined, owner, operationSignal)
        if (operationSignal.aborted || entry.starting !== starting) throw new Error("Connection initialization was replaced")
        entry.proc = proc
        entry.fork = proc.supportsForkSession()
        entry.subagents = proc.supportsSubagents()
        log.info("ACP getOrSpawnProcess: shared process ready", {
          key,
          directory,
          harness: this.harnessId(),
          ms: Date.now() - t0,
        })
        return { proc, isNew: true }
      } catch (err) {
        if (entry.starting === starting) entry.proc = null
        fencedRetirement(proc.dispose())
        throw err
      }
    })().finally(() => {
      if (entry.starting === starting) { entry.init = null; entry.starting = undefined; entry.startingProc = undefined }
    })
    return entry.init
  }

  protected async getOrSpawnProcess(id: string, directory: string, owner?: AgentSessionStartBinding): Promise<{ proc: ACPProcess; isNew: boolean }> {
    const key = this.keyForSession(id, directory)
    const entry = this.process(key, directory)
    entry.sessionIds.add(id)
    return this.getOrSpawnProcessForKey(key, directory, owner)
  }

  protected entryForSession(id: string) {
    const key = this.sessionOwnerKey(id)
    return this.processMap().get(key ?? id)
  }

  protected async getOrSpawnProbe(directory: string): Promise<ACPProcess> {
    if (this.probe && this.probe.directory !== directory) {
      fencedRetirement(this.restartProbe())
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
      await waitForACPTransportRetirement(root(), this.connection())
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
        fencedRetirement(proc.dispose())
        throw err
      } finally {
        if (this.probe?.init) this.probe.init = null
      }
    })()
    return this.probe.init
  }

  protected async boot(
    proc: {
      newSession: (directory: string, title?: string, sessionId?: string, start?: AgentSessionStartBinding, timeoutMs?: number) => Promise<string>
      dispose: () => void
    },
    directory: string,
    title?: string,
    sessionId?: string,
    ms = newSessionTimeoutMs(),
    start?: AgentSessionStartBinding,
  ) {
    let id: ReturnType<typeof setTimeout> | undefined
    try {
      if (start) return await proc.newSession(directory, title, sessionId, start, ms)
      return await Promise.race([
        proc.newSession(directory, title, sessionId),
        new Promise<string>((_, reject) => {
          id = setTimeout(() => reject(new Error(`ACP newSession timed out after ${ms}ms`)), ms)
        }),
      ])
    } catch (err) {
      log.warn("ACP newSession: failed", {
        directory,
        error: errorMessage(err),
      })
      if (!start) proc.dispose()
      throw err
    } finally {
      if (id) clearTimeout(id)
    }
  }

  protected async initialize(
    proc: {
      initialize: (owner?: AgentSessionStartBinding, signal?: AbortSignal) => Promise<void>
      dispose: () => void
      failureDetail?: () => string
    },
    ms = initializeTimeoutMs(),
    owner?: AgentSessionStartBinding,
    signal?: AbortSignal,
  ) {
    let id: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      return await (owner ? proc.initialize(owner, signal) : Promise.race([
        proc.initialize(undefined, signal),
        new Promise<void>((_, reject) => {
          id = setTimeout(() => { timedOut = true; reject(new Error(`ACP initialize timed out after ${ms}ms`)) }, ms)
        }),
      ]))
    } catch (err) {
      this.connectionUpdates?.get(proc)?.({ state: "failed", reason: timedOut ? "initialize_timeout" : "initialization_failed" })
      proc.dispose()
      const message = errorMessage(err)
      const detail = proc.failureDetail?.()
      if (message === "ACP connection closed" && detail) {
        throw new Error(`ACP connection closed: ${detail}`, { cause: err })
      }
      throw err
    } finally {
      if (id) clearTimeout(id)
    }
  }


  protected permissionOwnerMap() {
    this.permissionOwners ??= new Map<string, ACPProcess>()
    return this.permissionOwners
  }
}
