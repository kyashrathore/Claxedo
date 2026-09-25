import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import type { Deadline, HarnessServices, OwnedProcess } from "../../contract"

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
    { role, label: "Claude Code SDK", sessionId })
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
    this.retirement = this.started.then(async (owned) => {
      if (this.exited) return
      const outcome = await owned.retire(limit)
      if (!outcome.stopped) throw new Error(outcome.error.message)
    })
    return this.retirement
  }
}
