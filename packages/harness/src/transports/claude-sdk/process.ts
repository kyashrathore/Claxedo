import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import type { Deadline, HarnessServices, OwnedProcess } from "../../contract"
import { TransportError } from "../../contract/errors"
import { errorMessage, settleAtRequestDeadline, stringRecord } from "@claxedo/helpers"

const STDERR_TAIL = 4_096

function claudeRetirementDeadline(): Deadline {
  return { at: Date.now() + 5_000, signal: new AbortController().signal }
}

export async function retireClaudeProcesses(processes: Set<ClaudeProcess>, deadline: Deadline = claudeRetirementDeadline()): Promise<void> {
  await Promise.all([...processes].map(async (child) => {
    await child.retire(deadline)
    processes.delete(child)
  }))
}

export class ClaudeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly started: Promise<OwnedProcess>
  killed = false
  exitCode: number | null = null
  private exited = false
  private stderrTail = ""

  constructor(private readonly services: HarnessServices, options: SpawnOptions, sessionId: string, role: "harness" | "probe" = "harness") {
    super()
    this.started = services.spawn({ file: options.command, args: options.args, cwd: options.cwd ?? process.cwd(),
      env: stringRecord(options.env) },
    { role, label: "Claude Code SDK", sessionId, signal: options.signal }).catch((error: unknown) => {
      throw new TransportError("claude", "process", "Claude Code spawn failed", { retryable: true, cause: error })
    })
    const onAbort = () => { void this.retire(claudeRetirementDeadline()).catch((error: unknown) => this.fail(error)) }
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener("abort", onAbort, { once: true })
    this.started.then((owned) => {
      this.stdin.pipe(owned.stdin)
      owned.stdout.pipe(this.stdout)
      owned.stderr.on("data", (chunk: Buffer) => { this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL) })
      void owned.exited.then((exit) => {
        this.exitCode = exit.code
        this.exited = true
        this.emit("exit", this.exitCode, exit.signal)
      }, (error: unknown) => this.fail(error))
    }, (error: unknown) => this.fail(error))
  }

  get stderr(): string { return this.stderrTail }

  private fail(error: unknown): void {
    this.services.log.error("Claude process failed", { code: error instanceof TransportError ? error.code : "unknown" })
    if (this.listenerCount("error")) this.emit("error", error instanceof Error ? error : new Error(errorMessage(error)))
    this.stdout.destroy()
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    void this.retire(claudeRetirementDeadline()).then(undefined, (error: unknown) => this.fail(error))
    return true
  }

  async retire(limit: Deadline): Promise<void> {
    const stopping = this.started.then(async (owned) => {
      if (this.exited) return
      const outcome = await owned.retire(limit.at > Date.now() && !limit.signal.aborted ? limit : claudeRetirementDeadline())
      if (!outcome.stopped) throw new TransportError("claude", "process", outcome.error.message, { retryable: true })
    })
    return settleAtRequestDeadline("Claude Code spawn retirement",
      { deadlineAt: limit.at, signal: limit.signal }, stopping, () => {}, (_what, aborted) =>
        new TransportError("claude", "process", aborted ? "Claude Code spawn retirement cancelled" : "Claude Code spawn retirement timed out", { retryable: true }))
  }
}
