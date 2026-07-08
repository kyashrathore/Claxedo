import { spawn, type ChildProcess } from "child_process"
import { Log } from "../../log"
import { toOpencodeConfig, type ResolvedMcpServer } from "../../mcp-resolver"
import { workspaceDir } from "../../target"
import { opencodeAuthContent, prepareSpawnEnv, spawnEnv } from "./env"

const log = Log.create({ service: "opencode-adapter" })
const IDLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.CLAXEDO_OC_IDLE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5 * 60 * 1000
})()

export class OpenCodeServerProcess {
  private fixedUrl: string
  private opencodeUrl: string
  private proc: ChildProcess | null = null
  private spawnPromise: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private shouldSpawn: boolean

  constructor(
    opencodeUrl: string | undefined,
    private readonly input: {
      config: () => Record<string, ResolvedMcpServer>
      auth: () => Record<string, string>
    },
  ) {
    this.fixedUrl = opencodeUrl ?? ""
    this.opencodeUrl = this.fixedUrl
    this.shouldSpawn = !this.fixedUrl
  }

  get mode() {
    return this.shouldSpawn ? "spawned" : "external"
  }

  get hasProcess() {
    return !!this.proc
  }

  async ensureServer(): Promise<string> {
    if (this.opencodeUrl) {
      this.resetIdleTimer()
      return this.opencodeUrl
    }
    if (this.fixedUrl) {
      this.opencodeUrl = this.fixedUrl
      return this.opencodeUrl
    }
    if (!this.shouldSpawn) {
      throw new Error("No opencode server URL configured")
    }
    if (!this.spawnPromise) {
      this.spawnPromise = this.spawnServer()
    }
    await this.spawnPromise
    return this.opencodeUrl
  }

  restartSpawnedProcess() {
    if (!this.shouldSpawn || !this.proc) return false
    this.killProcess()
    return true
  }

  dispose() {
    this.killProcess()
  }

  private resetIdleTimer() {
    if (!this.proc) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      log.info("opencode process idle timeout, disposing", { idleMs: IDLE_TIMEOUT_MS })
      this.killProcess()
    }, IDLE_TIMEOUT_MS)
  }

  private async spawnServer(): Promise<void> {
    const port = 10000 + Math.floor(Math.random() * 50000)
    const directory = workspaceDir()

    log.info("Spawning opencode server", { port, directory })

    const auth = opencodeAuthContent(this.input.auth())
    const env = spawnEnv({
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(toOpencodeConfig(this.input.config())),
      ...(auth ? { OPENCODE_AUTH_CONTENT: auth } : {}),
    })
    await prepareSpawnEnv(env)
    const proc = spawn("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    })

    this.proc = proc

    proc.on("exit", (code, signal) => {
      log.info("opencode process exited", { code, signal })
      if (this.proc === proc) {
        this.proc = null
        this.opencodeUrl = ""
        this.spawnPromise = null
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
      }
    })

    proc.on("error", (err) => {
      log.error("opencode spawn error", { err })
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      log.info("opencode stderr", { text: chunk.toString().trim() })
    })

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for opencode server to start (15s)"))
      }, 15_000)

      let output = ""
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
        for (const line of output.split("\n")) {
          if (line.includes("opencode server listening")) {
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
            if (match) {
              clearTimeout(timeout)
              resolve(match[1]!)
              return
            }
          }
        }
      })

      proc.once("exit", (code) => {
        clearTimeout(timeout)
        reject(new Error(`opencode exited during startup (code ${code}):\n${output}`))
      })
    })

    this.opencodeUrl = url
    this.resetIdleTimer()
    log.info("opencode server started", { url })
  }

  private killProcess() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.proc) {
      log.info("Killing opencode process")
      try { this.proc.kill("SIGTERM") } catch {}
      this.proc = null
    }
    this.opencodeUrl = this.fixedUrl
    this.spawnPromise = null
  }
}
