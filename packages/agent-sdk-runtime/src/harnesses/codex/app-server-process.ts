import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { Log } from "../../log"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"
import { errorMessage, record, text, type JsonRecord } from "../shared/sdk-runtime-adapter"
import { isWindowsShimBinary, killHarnessProcess } from "../shared/windows-process"

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
  private proc: ChildProcess
  private buffer = ""
  private seq = 0
  private disposed = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(message: JsonRecord) => void>()
  private stderrListeners = new Set<(message: string) => void>()
  private observation: AgentProcessObserverHandle
  private observationExited = false

  private constructor(
    binary: string,
    directory: string,
    env: NodeJS.ProcessEnv,
    private readonly requestHandler: (message: JsonRecord) => Promise<unknown>,
    private readonly onClose: (error: Error) => void,
    processObserver?: AgentProcessObserver,
    mcp: Record<string, ResolvedMcpServer> = {},
  ) {
    const command = codexAppServerCommand(binary)
    const windowsShim = isWindowsShimBinary(command.command)
    this.proc = spawn(windowsShim ? `"${command.command}"` : command.command, command.args, {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(windowsShim ? { shell: true } : {}),
    })
    this.observation = observeCodexAppServerProcess({
      observer: processObserver,
      binary,
      directory,
      ...(this.proc.pid ? { pid: this.proc.pid } : {}),
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
    this.proc.on("error", (cause) => this.handleExit(cause instanceof Error ? cause : new Error(String(cause)), "error"))
    this.proc.on("exit", (code, signal) => {
      this.handleExit(new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`), "exited", code ?? undefined)
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
  }) {
    const process = new CodexAppServerProcess(
      input.binary,
      input.directory,
      input.env,
      input.requestHandler,
      input.onClose ?? (() => {}),
      input.processObserver,
      input.mcp,
    )
    const onAbort = () => process.dispose()
    try {
      if (input.signal?.aborted) throw new Error("Codex app-server startup was cancelled")
      input.signal?.addEventListener("abort", onAbort, { once: true })
      await process.request("initialize", {
        clientInfo: { name: "claxedo-workspace-runtime", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      process.notify("initialized")
      process.observation.update({ lifecycle: "ready" })
      return process
    } catch (cause) {
      process.dispose()
      throw cause
    } finally {
      input.signal?.removeEventListener("abort", onAbort)
    }
  }

  get alive() {
    return this.proc.exitCode === null && !this.proc.killed
  }

  onMessage(listener: (message: JsonRecord) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStderr(listener: (message: string) => void) {
    this.stderrListeners.add(listener)
    return () => this.stderrListeners.delete(listener)
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: unknown, result: unknown) {
    this.write({ id, result })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.exitObservation({ reason: "disposed" })
    const error = new Error("codex app-server process was disposed")
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    killHarnessProcess(this.proc, "SIGTERM")
    this.killTimer = setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) killHarnessProcess(this.proc, "SIGKILL")
    }, 1_000)
    this.killTimer.unref()
  }

  private handleExit(error: Error, reason: "error" | "exited", exitCode?: number) {
    if (this.killTimer) clearTimeout(this.killTimer)
    this.exitObservation({ reason, ...(exitCode !== undefined ? { exitCode } : {}) })
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
    if (!this.disposed) this.onClose(error)
  }

  private exitObservation(input: { reason: "error" | "exited" | "disposed"; exitCode?: number }) {
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
    let message: JsonRecord
    try {
      message = JSON.parse(line) as JsonRecord
    } catch {
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
        .catch((error) => this.write({ id: message.id, error: { message: errorMessage(error) } }))
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  private resolveResponse(id: number, message: JsonRecord) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = record(message.error)
    if (error) {
      pending.reject(new Error(text(error.message) ?? `codex app-server request ${id} failed`))
      return
    }
    pending.resolve(message.result)
  }
}
