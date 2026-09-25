import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import type { Deadline, HarnessServices, OwnedProcess } from "../../contract"
import { ClaudeTransportError } from "./errors"

function claudeRetirementDeadline(): Deadline {
  return { at: Date.now() + 5_000, signal: new AbortController().signal }
}

export class ClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly started: Promise<OwnedProcess>
  killed = false
  exitCode: number | null = null
  private exited = false
  private retirement?: Promise<void>

  constructor(private readonly services: HarnessServices, options: SpawnOptions, sessionId: string, role: "harness" | "probe" = "harness") {
    super()
    this.started = services.spawn({ file: options.command, args: options.args, cwd: options.cwd ?? process.cwd(),
      env: Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) },
    { role, label: "Claude Code SDK", sessionId }).catch((error: unknown) => {
      throw new ClaudeTransportError("process", "Claude Code spawn failed", true, { cause: error })
    })
    const onAbort = () => { void this.retire(claudeRetirementDeadline()).catch((error: unknown) => this.fail(error)) }
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener("abort", onAbort, { once: true })
    this.started.then((owned) => {
      this.stdin.pipe(owned.stdin)
      owned.stdout.pipe(this.stdout)
      owned.stderr.on("data", (chunk: Buffer) => services.log.debug("Claude stderr", { text: chunk.toString() }))
      void owned.exited.then((exit) => {
        this.exitCode = exit.code
        this.exited = true
        this.emit("exit", this.exitCode, exit.signal)
      }, (error: unknown) => this.fail(error))
    }, (error: unknown) => this.fail(error))
  }

  private fail(error: unknown): void {
    this.services.log.error("Claude process failed", { error: error instanceof Error ? error.message : String(error) })
    if (this.listenerCount("error")) this.emit("error", error instanceof Error ? error : new Error(String(error)))
    this.stdout.destroy()
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    this.retirement = this.retire(claudeRetirementDeadline())
    void this.retirement.then(undefined, (error: unknown) => this.fail(error))
    return true
  }

  async retire(limit: Deadline): Promise<void> {
    if (this.retirement) return this.retirement
    const stopping = this.started.then(async (owned) => {
      if (this.exited) return
      const outcome = await owned.retire(limit.at > Date.now() && !limit.signal.aborted ? limit : claudeRetirementDeadline())
      if (!outcome.stopped) throw new ClaudeTransportError("process", outcome.error.message, true)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ClaudeTransportError("process", "Claude Code spawn retirement timed out", true)),
        Math.max(0, limit.at - Date.now()))
      onAbort = () => reject(new ClaudeTransportError("process", "Claude Code spawn retirement cancelled", true))
      if (limit.signal.aborted) onAbort()
      else limit.signal.addEventListener("abort", onAbort, { once: true })
    })
    this.retirement = Promise.race([stopping, deadline]).finally(() => {
      if (timer) clearTimeout(timer)
      if (onAbort) limit.signal.removeEventListener("abort", onAbort)
    })
    return this.retirement
  }
}
