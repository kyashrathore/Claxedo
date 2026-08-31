import { createHash, randomUUID } from "crypto"
import type { McpServer } from "@agentclientprotocol/sdk"
import { Log } from "../../log"
import { ACP_RECOVER } from "./recovery"
import { ACPProcess } from "./process"
import { createSessionTurnLifecycle, type SessionTurnLifecycle } from "../shared/turn-lifecycle"
import { createStdioACPTransport, type ACPTransportEnv } from "./transport"
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
  sessionIds: Set<string>
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
  protected turnLifecycle = createSessionTurnLifecycle<ActiveAcpTurn>()
  protected processes = new Map<ACPProcessKey, ProcEntry>()
  protected sessionProcesses = new Map<string, ACPProcessKey>()
  protected ignoreStoredProcessKeys = false
  protected permissionOwners = new Map<string, ACPProcess>()
  protected probe: ProbeEntry | null = null
  protected configRestartPending = false

  constructor(protected readonly options: AcpHarnessAdapterOptions) {
    this.store = options.store ?? options.createStore?.(options.storeRoot) ?? missingStore()
    this.ownsStore = !options.store
    this.currentEnv = options.env ?? {}
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

  protected legacySessions() {
    return (this as unknown as { sessions?: Map<string, { proc?: ACPProcess | null; directory?: string; init?: unknown }> }).sessions
  }

  protected processEntries(): Iterable<{ proc?: ACPProcess | null }> {
    const processes = this.processMap()
    if (processes.size > 0) return processes.values()
    return this.legacySessions()?.values() ?? []
  }

  protected processKey(directory: string): ACPProcessKey {
    const options = this.options ?? { binary: "" }
    return processFingerprint({
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

  protected keyForSession(id: string, directory: string): ACPProcessKey {
    const key = this.sessionProcessMap().get(id) ?? (this.ignoreStoredProcessKeys ? null : this.store.getSessionOwnerKey?.(id)) ?? this.processKey(directory)
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

  protected restartProcess(key: ACPProcessKey) {
    const entry = this.processMap().get(key)
    for (const id of entry?.sessionIds ?? []) {
      this.lifecycle().drain(id, "ACP session process restarted")
    }
    entry?.proc?.dispose()
    if (!entry) return
    entry.proc = null
    entry.init = null
  }

  protected restartProbe() {
    this.probe?.proc?.dispose()
    if (!this.probe) return
    this.probe.proc = null
    this.probe.init = null
  }

  protected restart() {
    this.lifecycle().drainAll("ACP session process restarted")
    for (const key of this.processMap().keys()) {
      this.restartProcess(key)
    }
    this.restartProbe()
  }

  protected closeStore() {
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

  protected make(directory: string, role: "harness" | "probe", dead: () => void = () => {}) {
    const launch = { args: this.options.args ?? [], env: this.currentEnv }
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

  protected async getOrSpawnProcessForKey(key: ACPProcessKey, directory: string): Promise<{ proc: ACPProcess; isNew: boolean }> {
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

  protected async getOrSpawnProcess(id: string, directory: string): Promise<{ proc: ACPProcess; isNew: boolean }> {
    const key = this.keyForSession(id, directory)
    const entry = this.process(key, directory)
    entry.sessionIds.add(id)
    return this.getOrSpawnProcessForKey(key, directory)
  }

  protected entryForSession(id: string) {
    const key = this.sessionProcessMap().get(id) ?? this.store.getSessionOwnerKey?.(id)
    return key ? this.processMap().get(key) : this.legacySessions()?.get(id)
  }

  protected async getOrSpawnProbe(directory: string): Promise<ACPProcess> {
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

  protected async boot(
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

  protected async initialize(
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


  protected permissionOwnerMap() {
    this.permissionOwners ??= new Map<string, ACPProcess>()
    return this.permissionOwners
  }
}
