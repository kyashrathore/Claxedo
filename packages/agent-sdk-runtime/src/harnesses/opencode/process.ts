import { spawn, type ChildProcess } from "child_process"
import { randomBytes, randomUUID } from "crypto"
import { Log } from "../../log"
import { toOpencodeConfig, type ResolvedMcpServer } from "../../mcp-resolver"
import { workspaceDir } from "../../target"
import { opencodeAuthContent, prepareSpawnEnv, spawnEnv } from "./env"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"
import {
  createProcessLifecycle,
  type ActivityLease,
  type ProcessLifecycle,
} from "../shared/process-lifecycle"

const log = Log.create({ service: "opencode-adapter" })

/**
 * Lease-based idle grace for a spawned server. The countdown begins after the
 * final request, stream, or subscription releases.
 */
const IDLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.CLAXEDO_OC_IDLE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 30_000
})()

export function openCodeSpawnConfigContent(
  configured: string | undefined,
  mcp: Record<string, ResolvedMcpServer>,
) {
  const parsed = configured?.trim() ? JSON.parse(configured) as unknown : {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object")
  }
  const base = parsed as Record<string, unknown>
  const generated = toOpencodeConfig(mcp)
  const generatedMcp = generated.mcp as Record<string, unknown> | undefined
  const configuredMcp = base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp)
    ? base.mcp as Record<string, unknown>
    : undefined
  return JSON.stringify({
    ...base,
    ...generated,
    ...(configuredMcp || generatedMcp
      ? { mcp: { ...(configuredMcp ?? {}), ...(generatedMcp ?? {}) } }
      : {}),
  })
}

/** A running server plus the credential this launch requires. */
export type OpenCodeServerConnection = {
  url: string
  /** `Basic ...` for a spawned server; absent for an external URL. */
  authorization?: string
}

/**
 * A fresh per-launch server credential.
 *
 * A spawned `opencode serve` binds loopback and requires a credential because
 * loopback does not isolate local users or processes.
 *
 * Passed through the environment, never argv: process arguments are readable
 * by any local user through `ps`, which would put the credential on the very
 * surface it defends against.
 */
function launchCredential() {
  return randomBytes(24).toString("base64url")
}

/** Never let a credential reach a log line, however the caller framed it. */
export function redact(text: string, credential: string | undefined) {
  return credential ? text.split(credential).join("«redacted»") : text
}

export class OpenCodeServerProcess {
  private readonly fixedUrl: string
  private readonly shouldSpawn: boolean
  private readonly lifecycle: ProcessLifecycle<SpawnedServer>

  constructor(
    opencodeUrl: string | undefined,
    private readonly input: {
      config: () => Record<string, ResolvedMcpServer>
      auth: () => Record<string, string>
      processObserver?: AgentProcessObserver
      /**
       * Injected so the spawn path itself is testable — the child's own exit
       * handling is lifecycle-critical and was otherwise reachable only by
       * launching a real `opencode`. Defaults to `child_process.spawn`.
       */
      spawn?: typeof spawn
    },
  ) {
    this.fixedUrl = opencodeUrl ?? ""
    this.shouldSpawn = !this.fixedUrl
    this.lifecycle = createProcessLifecycle<SpawnedServer>({
      idleGraceMs: IDLE_TIMEOUT_MS,
      start: ({ signal, generation }) => this.spawnServer(signal, generation),
      stop: ({ handle }) => stopSpawnedServer(handle),
      onEvent: (event) => {
        if (event.type === "idle-timeout") {
          log.info("opencode process idle timeout, disposing", { idleMs: IDLE_TIMEOUT_MS })
        }
        if (event.type === "start-failed") {
          log.error("opencode spawn failed", { generation: event.generation })
        }
      },
    })
  }

  get mode() {
    return this.shouldSpawn ? "spawned" : "external"
  }

  get hasProcess() {
    return this.lifecycle.state() === "ready"
  }

  /** Resolve the server URL, starting a child if this is spawn mode. */
  async ensureServer(): Promise<string> {
    return (await this.ensureConnection()).url
  }

  /**
   * Resolve the URL plus the credential this launch requires.
   *
   * Every adapter HTTP call goes through one seam (`requestFn`), and that seam
   * needs both. Returning them together is what stops a caller reaching the
   * server without its `Authorization` header.
   */
  async ensureConnection(): Promise<OpenCodeServerConnection> {
    if (this.fixedUrl) return { url: this.fixedUrl }
    if (!this.shouldSpawn) throw new Error("No opencode server URL configured")
    const server = await this.lifecycle.ensure()
    return { url: server.url, authorization: server.authorization }
  }

  /**
   * Hold the server open for work that outlives a single request.
   *
   * Response streams and client-owned event streams must take a lease; without
   * one the idle countdown starts the moment the request returns and can tear
   * the child down while its stream is still delivering.
   */
  async acquire(): Promise<{ connection: OpenCodeServerConnection; lease: ActivityLease }> {
    if (this.fixedUrl) return { connection: { url: this.fixedUrl }, lease: { release() {} } }
    const { handle, lease } = await this.lifecycle.acquire()
    return { connection: { url: handle.url, authorization: handle.authorization }, lease }
  }

  restartSpawnedProcess() {
    if (!this.shouldSpawn || this.lifecycle.state() === "absent") return false
    void this.lifecycle.stop("restart")
    return true
  }

  dispose() {
    void this.lifecycle.dispose()
  }

  private async spawnServer(signal: AbortSignal, generation: number): Promise<SpawnedServer> {
    const port = 10000 + Math.floor(Math.random() * 50000)
    const directory = workspaceDir()
    const credential = launchCredential()

    log.info("Spawning opencode server", { port, directory })

    const auth = opencodeAuthContent(this.input.auth())
    const env = spawnEnv({
      ...process.env,
      OPENCODE_CONFIG_CONTENT: openCodeSpawnConfigContent(process.env.OPENCODE_CONFIG_CONTENT, this.input.config()),
      // Through the environment, never argv — see `launchCredential`.
      OPENCODE_SERVER_PASSWORD: credential,
      ...(auth ? { OPENCODE_AUTH_CONTENT: auth } : {}),
    })
    await prepareSpawnEnv(env)
    // The named call preserves dependency injection and remains visible to the
    // desktop process inventory scanner.
    const spawnChild = this.input.spawn ?? spawn
    const proc = spawnChild("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    })

    const observation = observeOpenCodeServerProcess({
      observer: this.input.processObserver,
      ...(proc.pid ? { pid: proc.pid } : {}),
      directory,
      config: this.input.config(),
    })

    proc.on("error", (err) => {
      observation.exit({ reason: "error" })
      log.error("opencode spawn error", { err })
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      log.info("opencode stderr", { text: redact(chunk.toString().trim(), credential) })
    })

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for opencode server to start (15s)"))
      }, 15_000)
      const onAbort = () => {
        clearTimeout(timeout)
        reject(new Error("opencode startup aborted"))
      }
      signal.addEventListener("abort", onAbort, { once: true })

      let output = ""
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
        for (const line of output.split("\n")) {
          if (!line.includes("opencode server listening")) continue
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
          if (!match) continue
          clearTimeout(timeout)
          signal.removeEventListener("abort", onAbort)
          resolve(match[1]!)
          return
        }
      })

      proc.once("exit", (code) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
        reject(new Error(`opencode exited during startup (code ${code}):\n${redact(output, credential)}`))
      })
    }).catch((error) => {
      // A child that failed to announce itself is still a child. Reap it here
      // rather than leaving an orphan holding the port.
      observation.exit({ reason: "error" })
      try { proc.kill("SIGTERM") } catch {}
      throw error
    })

    observation.update({ lifecycle: "ready" })
    log.info("opencode server started", { url })

    const server: SpawnedServer = {
      url,
      authorization: `Basic ${Buffer.from(`opencode:${credential}`).toString("base64")}`,
      proc,
      observation,
    }
    proc.on("exit", (code, signal_) => {
      observation.exit({ reason: "exited", ...(code !== null ? { exitCode: code } : {}) })
      log.info("opencode process exited", { code, signal: signal_ })
      // Scope the exit to its generation so it cannot stop a replacement.
      void this.lifecycle.stop("explicit", { generation })
    })
    return server
  }
}

type SpawnedServer = {
  url: string
  authorization: string
  proc: ChildProcess
  observation: AgentProcessObserverHandle
}

async function stopSpawnedServer(server: SpawnedServer) {
  log.info("Killing opencode process")
  server.observation.exit({ reason: "disposed" })
  try {
    server.proc.kill("SIGTERM")
  } catch {
    // Already gone.
  }
}

export function observeOpenCodeServerProcess(input: {
  observer?: AgentProcessObserver
  pid?: number
  directory: string
  config?: Record<string, ResolvedMcpServer>
}): AgentProcessObserverHandle {
  const ownerId = `opencode-server:${randomUUID()}`
  const handles = [
    observeAgentProcess(input.observer, {
      ownerId,
      launchId: randomUUID(),
      harnessId: "opencode",
      access: "native",
      role: "harness",
      label: "OpenCode server",
      locality: "local-process",
      confidence: input.pid ? "direct" : "inferred",
      capabilities: {
        resourceMetrics: "process",
        ownerActions: false,
      },
      ...(input.pid ? { pid: input.pid } : {}),
      directory: input.directory,
      executableBasename: "opencode",
    }),
    ...Object.values(input.config ?? {}).map((server) => observeAgentProcess(input.observer, {
      ownerId: `opencode-mcp:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "opencode",
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
      ...(server.transport === "stdio"
        ? { executableBasename: server.command.split(/[\\/]/).at(-1) || "mcp" }
        : {}),
    })),
  ]
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
