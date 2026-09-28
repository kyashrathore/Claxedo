import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import type { ExitStatus, OwnedProcess } from "../contract"

let launches = 0

export class ScriptedProcess<Frame> {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly received: Frame[] = []
  readonly writeErrors: Error[] = []
  readonly pid = 4_194_305 + launches++
  retirements = 0
  retirementGate?: Promise<void>
  retirement: Awaited<ReturnType<OwnedProcess["retire"]>> = { stopped: true }
  private ended = false
  private finish!: (exit: ExitStatus) => void
  readonly exited = new Promise<ExitStatus>((resolve) => { this.finish = resolve })

  constructor(receive: (frame: Frame, process: ScriptedProcess<Frame>) => void) {
    this.stdin.on("error", (error) => { this.writeErrors.push(error) })
    createInterface({ input: this.stdin }).on("line", (line) => {
      if (!line.trim()) return
      const frame = JSON.parse(line) as Frame
      this.received.push(frame)
      receive(frame, this)
    })
  }

  send(frame: unknown): void {
    if (!this.ended) this.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  exit(status: ExitStatus = { code: 0, signal: null }): void {
    if (this.ended) return
    this.ended = true
    this.stdout.end()
    this.stderr.end()
    this.finish(status)
  }

  owned(): OwnedProcess {
    return { pid: this.pid, stdin: this.stdin, stdout: this.stdout, stderr: this.stderr, exited: this.exited,
      retire: async () => {
        this.retirements++
        await this.retirementGate
        if (this.retirement.stopped) this.exit()
        return this.retirement
      } }
  }
}
