import type { Clock, Deadline, OwnedProcess } from "../contract"

const STDERR_CLOSE_MS = 1_000

export class NdjsonOwnedProcess {
  private buffer = ""
  private failure?: Error
  private whole?: Promise<Error>
  private readonly failures = new Set<(error: Error) => void>()

  constructor(readonly process: OwnedProcess, private readonly clock: Clock,
    private readonly receive: (value: unknown) => void,
    private readonly error: (reason: "frame" | "stdout" | "exit" | "write", cause?: unknown) => Error,
    private readonly retirementFailure: (error: unknown) => void,
    private readonly maxFrameLength = 16 * 1024 * 1024) {
    process.stdout.setEncoding("utf8")
    process.stdout.on("data", (chunk: string) => this.read(chunk))
    process.stdout.on("error", (cause: unknown) => this.fail(this.error("stdout", cause)))
    void process.exited.then((exit) => this.exited(() => this.error("exit", exit)),
      (cause: unknown) => this.fail(this.error("exit", cause)))
  }

  private exited(error: () => Error): void {
    if (this.failure) return
    this.whole = this.stderrClosed().then(() => error())
    this.fail(error(), false)
  }

  wholeFailure(): Promise<Error> | undefined {
    return this.whole ?? (this.failure && Promise.resolve(this.failure))
  }

  private stderrClosed(): Promise<void> {
    if (this.process.stderr.destroyed) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(resolve, STDERR_CLOSE_MS)
      this.process.stderr.once("close", () => { this.clock.clearTimeout(timer); resolve() })
    })
  }

  get alive(): boolean { return this.failure === undefined }

  onFailure(listener: (error: Error) => void): () => void {
    if (this.failure) listener(this.failure)
    else this.failures.add(listener)
    return () => this.failures.delete(listener)
  }

  send(message: unknown): void {
    if (this.failure) throw this.failure
    this.process.stdin.write(`${JSON.stringify(message)}\n`, (cause?: Error | null) => {
      if (cause) this.fail(this.error("write", cause))
    })
  }

  fail(error: Error, retire = true): void {
    if (this.failure) return
    this.failure = error
    for (const listener of this.failures) listener(error)
    if (retire) {
      const deadline: Deadline = { at: this.clock.now() + 5_000, signal: new AbortController().signal }
      void this.process.retire(deadline).then((outcome) => {
        if (!outcome.stopped) this.retirementFailure(outcome.error)
      }, this.retirementFailure)
    }
  }

  private read(chunk: string): void {
    if (this.failure) return
    this.buffer += chunk
    let end = this.buffer.indexOf("\n")
    while (end >= 0) {
      if (end > this.maxFrameLength) { this.fail(this.error("frame"), true); return }
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) {
        try { this.receive(JSON.parse(line) as unknown) }
        catch (cause) { this.fail(this.error("frame", cause), true); return }
      }
      end = this.buffer.indexOf("\n")
    }
    if (this.buffer.length > this.maxFrameLength) this.fail(this.error("frame"), true)
  }
}
