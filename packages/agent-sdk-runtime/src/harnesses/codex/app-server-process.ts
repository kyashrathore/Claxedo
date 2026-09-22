import { type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { DEFAULT_RECOVERY_BUDGETS, type RecoveryBudgets } from "@claxedo/agent-runtime-contract"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { Log } from "../../log"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"
import { asRecord } from "@claxedo/helpers/guards"
import { errorMessage, text, type JsonRecord } from "../shared/sdk-runtime-adapter"
import { resolveHarnessCommand } from "../shared/windows-process"
import {
  launchOwnedProcess,
  settleAtRequestDeadline,
  RecoveryCodedError,
  type LaunchOwnershipStore,
  type OwnedLaunch,
  type CreationIdentity,
  type RequestDeadline,
  type RetirementResult,
} from "../../launch"

const log = Log.create({ service: "codex-app-server-process" })

/**
 * The argv a Codex app-server launch uses. Named and exported so the Agent
 * Plugins launch check can assert that activating a marketplace adds no argv
 * overrides — the generated marketplace is read from the managed Codex home
 * instead. It lives here, beside the only spawn site, so the guard cannot
 * drift from what actually launches.
 */
export function codexAppServerCommand(binary: string) {
  const args = ["app-server", "--listen", "stdio://"]
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) return { command: process.execPath, args: [binary, ...args] }
  return { command: binary, args }
}

function executableBasename(input: string) {
  return input.split(/[\\/]/).at(-1) || "codex"
}

function compositeObservation(handles: AgentProcessObserverHandle[]): AgentProcessObserverHandle {
  let exited = false
  return {
    update(event) {
      handles.forEach((handle) => handle.update(event))
    },
    exit(event) {
      if (exited) return
      exited = true
      handles.forEach((handle) => handle.exit(event))
    },
  }
}

export function observeCodexAppServerProcess(input: {
  observer?: AgentProcessObserver
  binary: string
  directory: string
  pid?: number
  mcp?: Record<string, ResolvedMcpServer>
}): AgentProcessObserverHandle {
  const ownerId = `codex-app-server:${randomUUID()}`
  return compositeObservation([
    observeAgentProcess(input.observer, {
      ownerId,
      launchId: randomUUID(),
      harnessId: "codex",
      access: "native",
      role: "harness",
      label: "Codex app server",
      locality: "local-process",
      confidence: input.pid ? "direct" : "inferred",
      capabilities: { resourceMetrics: "process", ownerActions: false },
      ...(input.pid ? { pid: input.pid } : {}),
      directory: input.directory,
      executableBasename: executableBasename(input.binary),
    }),
    ...Object.values(input.mcp ?? {}).map((server) => observeAgentProcess(input.observer, {
      ownerId: `codex-mcp:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "codex",
      access: "native",
      role: "mcp" as const,
      label: `MCP ${server.name}`,
      locality: server.transport === "stdio" ? "local-process" as const : "remote" as const,
      confidence: server.transport === "stdio" ? "inferred" as const : "not-process-backed" as const,
      capabilities: {
        resourceMetrics: server.transport === "stdio" ? "process" as const : "none" as const,
        ownerActions: false,
      },
      parentOwnerId: ownerId,
      directory: input.directory,
      mcpName: server.name,
      transport: server.transport === "stdio" ? "stdio" as const : "streamable-http" as const,
      ...(server.transport === "stdio" ? { executableBasename: executableBasename(server.command) } : {}),
    })),
  ])
}

export class CodexAppServerProcess {
  private readonly proc: ChildProcess
  private buffer = ""
  private seq = 0
  private disposed = false
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(message: JsonRecord) => void>()
  private stderrListeners = new Set<(message: string) => void>()
  private observation: AgentProcessObserverHandle
  private observationExited = false
  private retirement: Promise<RetirementResult> | undefined

  private constructor(
    private readonly launch: OwnedLaunch,
    private readonly budgets: RecoveryBudgets,
    binary: string,
    directory: string,
    private readonly requestHandler: (message: JsonRecord) => Promise<unknown>,
    private readonly onClose: (error: Error) => void,
    processObserver?: AgentProcessObserver,
    mcp: Record<string, ResolvedMcpServer> = {},
  ) {
    this.proc = launch.child
    this.observation = observeCodexAppServerProcess({
      observer: processObserver,
      binary,
      directory,
      ...(launch.payloadPid ? { pid: launch.payloadPid } : {}),
      mcp,
    })
    this.proc.stdout?.setEncoding("utf8")
    this.proc.stderr?.setEncoding("utf8")
    this.proc.stdout?.on("data", (chunk: string) => this.read(chunk))
    this.proc.stderr?.on("data", (chunk: string) => {
      const message = chunk.trim()
      log.warn("codex app-server stderr", { message })
      for (const listener of this.stderrListeners) listener(message)
    })
    this.proc.on("error", (cause) => this.handleFailure(cause instanceof Error ? cause : new Error(String(cause))))
    this.proc.on("exit", (code, signal) => {
      this.handleExit(new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`), code ?? undefined)
    })
  }

  static async start(input: {
    binary: string
    directory: string
    env: NodeJS.ProcessEnv
    requestHandler: (message: JsonRecord) => Promise<unknown>
    onClose?: (error: Error) => void
    processObserver?: AgentProcessObserver
    mcp?: Record<string, ResolvedMcpServer>
    signal?: AbortSignal
    /** Required: a composition with no durable store passes the volatile one itself. */
    ownership: LaunchOwnershipStore
    /** The workspace this launch is recorded under, and reconciled with. */
    workspaceId: string
    sessionId?: string
    budgets?: Partial<RecoveryBudgets>
    /** Called with what retiring a failed startup's process established, and whose launch it was. */
    onRetired?: (result: RetirementResult, identity: CreationIdentity) => void
  }) {
    if (input.signal?.aborted) throw new Error("Codex app-server startup was cancelled")
    const budgets = { ...DEFAULT_RECOVERY_BUDGETS, ...input.budgets }
    const command = codexAppServerCommand(input.binary)
    // A .cmd/.bat binary is resolved to the executable it wraps rather than
    // routed through cmd.exe, so the gate spawns a literal argv.
    const payload = resolveHarnessCommand(command.command, command.args, input.env, input.directory)
    const launch = await launchOwnedProcess({
      ownership: input.ownership,
      role: "harness",
      scope: { workspaceId: input.workspaceId, directory: input.directory, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
      payload,
      cwd: input.directory,
      env: input.env,
    })
    const server = new CodexAppServerProcess(
      launch,
      budgets,
      input.binary,
      input.directory,
      input.requestHandler,
      input.onClose ?? (() => {}),
      input.processObserver,
      input.mcp,
    )
    // Fire-and-forget: the abort path's retirement is awaited by the `catch`
    // below, which the aborted `initialize` reaches on the same signal.
    const onAbort = () => void server.dispose()
    try {
      input.signal?.addEventListener("abort", onAbort, { once: true })
      await server.request("initialize", {
        clientInfo: { name: "claxedo-workspace-runtime", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, startupDeadline(budgets, input.signal))
      server.notify("initialized")
      server.observation.update({ lifecycle: "ready" })
      return server
    } catch (cause) {
      // Awaited, not fired and forgotten: a startup that failed must not leave
      // its process running behind the caller it just rejected. `dispose()`
      // never rejects, and it answers with what the retirement established.
      input.onRetired?.(await server.dispose(), server.launchIdentity)
      throw cause
    } finally {
      input.signal?.removeEventListener("abort", onAbort)
    }
  }

  get alive() {
    return this.proc.exitCode === null && !this.proc.killed
  }

  /** The launch's recorded identity, so an owner holding it can re-verify it later. */
  get launchIdentity() {
    return this.launch.identity
  }

  /** The OS process, for an owner that needs to observe it directly. */
  get child() {
    return this.proc
  }

  onMessage(listener: (message: JsonRecord) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStderr(listener: (message: string) => void) {
    this.stderrListeners.add(listener)
    return () => this.stderrListeners.delete(listener)
  }

  request(method: string, params: unknown, deadline: RequestDeadline): Promise<unknown> {
    // A request written to an exited process's stdin is never answered and
    // would sit here until its deadline, reporting a timeout where the real
    // answer is that there is nothing to ask.
    //
    // `alive` is not the test: it reads `killed`, which node sets the moment a
    // signal is delivered — so during the TERM grace a process still answering
    // normally would have its requests refused.
    if (this.disposed || this.proc.exitCode !== null) {
      return Promise.reject(new RecoveryCodedError(
        "provider_unreachable",
        `codex ${method} was not sent: this owner has retired the app-server or it has exited`,
      ))
    }
    const id = ++this.seq
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
    return settleAtRequestDeadline(`codex ${method}`, deadline, answer, () => this.pending.delete(id))
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: unknown, result: unknown) {
    this.write({ id, result })
  }

  /**
   * Retires the launch and answers with what was established: whether the
   * leader exited, whether anything it owned is still running, and which
   * signals were refused. It settles inside the TERM and KILL budgets, so an
   * owner that awaits it before deleting a working directory is told what it
   * is deleting under rather than waiting forever for a proof that will not
   * come.
   */
  dispose(): Promise<RetirementResult> {
    this.retirement ??= this.retireLaunch()
    return this.retirement
  }

  private async retireLaunch(): Promise<RetirementResult> {
    this.disposed = true
    const error = new Error("codex app-server process was disposed")
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
    const result = await this.launch.retire(this.budgets)
    if (result.leader === "exited") this.exitObservation({ reason: "disposed" })
    return result
  }

  private handleExit(error: Error, exitCode?: number) {
    // Node observed the leader exit, which is the only exit evidence this owner
    // ever gets; what the group still holds is established by retirement.
    this.exitObservation({ reason: "exited", ...(exitCode !== undefined ? { exitCode } : {}) })
    this.handleFailure(error)
  }

  /**
   * The child could not be spawned or its stdio broke. Neither says the process
   * stopped — the payload runs inside the gate's group and may outlive this
   * stream — so nothing is published as an exit from here.
   */
  private handleFailure(error: Error) {
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
    if (!this.disposed) this.onClose(error)
  }

  private exitObservation(input: { reason: "exited" | "disposed"; exitCode?: number }) {
    if (this.observationExited) return
    this.observationExited = true
    this.observation.exit(input)
  }

  private write(message: JsonRecord) {
    this.proc.stdin?.write(JSON.stringify(message) + "\n")
  }

  private read(chunk: string) {
    this.buffer += chunk
    while (true) {
      const boundary = this.buffer.indexOf("\n")
      if (boundary < 0) return
      const line = this.buffer.slice(0, boundary).trim()
      this.buffer = this.buffer.slice(boundary + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string) {
    let message: JsonRecord | undefined
    try {
      message = asRecord(JSON.parse(line))
    } catch {
      message = undefined
    }
    if (!message) {
      log.warn("codex app-server emitted non-json line", { line })
      return
    }
    const method = text(message.method)
    const id = typeof message.id === "number" ? message.id : undefined
    if (id !== undefined && ("result" in message || "error" in message)) {
      this.resolveResponse(id, message)
      return
    }
    if (!method) return
    if (message.id !== undefined) {
      this.requestHandler(message)
        .then((result) => this.respond(message.id, result))
        .catch((error) => this.write({ id: message.id, error: { code: -32603, message: errorMessage(error) } }))
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  private resolveResponse(id: number, message: JsonRecord) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = asRecord(message.error)
    if (error) {
      pending.reject(new Error(text(error.message) ?? `codex app-server request ${id} failed`))
      return
    }
    pending.resolve(message.result)
  }
}

function startupDeadline(budgets: RecoveryBudgets, signal?: AbortSignal): RequestDeadline {
  return { signal: signal ?? new AbortController().signal, deadlineAt: Date.now() + budgets.providerQueryMs }
}
