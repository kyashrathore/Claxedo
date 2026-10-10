import { Buffer } from "node:buffer"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { ABORT, COMMIT, FAILED, FATAL, PUBLISHED, READY, SERVING, payloadFrame, requestFrame } from "./windows-private-file-program"

export type PrivateStagingReport = {
  /** The descriptor the staging file was born with, read back through its own handle. */
  sddl: string
  /** The process holding that handle, so a caller can establish what happens when it dies. */
  holder: number | undefined
}

export type PrivateWriteRequest = {
  target: string
  staging: string
  contents: Uint8Array
  beforeWrite?: (report: PrivateStagingReport) => void | Promise<void>
}

/** The runner's own reason for not publishing, as opposed to a failure the caller's hook raised. */
export class RunnerRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunnerRefusal"
  }
}

export type PrivateFileRunnerOptions = {
  launch: () => ChildProcessWithoutNullStreams
  /** How long one request may wait for any answer, a fresh runner's startup included. */
  answerTimeoutMs: number
  /** How long a runner is given to acknowledge an abort before it is discarded. */
  abortGraceMs: number
}

/**
 * One runner process at a time, started on the first request and replaced
 * after it dies, wedges, or says something this side cannot place. Requests
 * run one after another in the order they arrived.
 */
export function createPrivateFileRunner(options: PrivateFileRunnerOptions) {
  let current: RunnerProcess | undefined
  let tail: Promise<unknown> = Promise.resolve()

  const perform = async (request: PrivateWriteRequest) => {
    if (!current || current.lost) current = new RunnerProcess(options.launch)
    const runner = current
    runner.hold()
    try {
      await exchange(runner, request, options)
    } finally {
      runner.idle()
    }
  }

  return (request: PrivateWriteRequest): Promise<void> => {
    const turn = tail.then(() => perform(request))
    tail = turn.catch(() => undefined)
    return turn
  }
}

async function exchange(runner: RunnerProcess, request: PrivateWriteRequest, options: PrivateFileRunnerOptions) {
  // Referenced on purpose: Bun on Windows never fires an unreferenced timer
  // that is the loop's only work, and a wedged runner is exactly that case.
  const expired = Promise.withResolvers<never>()
  expired.promise.catch(() => undefined)
  const timer = setTimeout(
    () => expired.reject(new RunnerRefusal(`no answer within ${options.answerTimeoutMs}ms`)),
    options.answerTimeoutMs,
  )
  const within = <T>(work: Promise<T>) => Promise.race([work, expired.promise])

  try {
    // A runner that wedges or dies before it answers is the one case where
    // nothing can be asked of it any more; it is replaced.
    const answer = async () => {
      try {
        return await within(runner.answer())
      } catch (error) {
        throw runner.discard(error instanceof RunnerRefusal ? error.message : String(error))
      }
    }

    if (!runner.serving) {
      const greeting = await answer()
      if (greeting !== SERVING) throw runner.discard(`unexpected greeting ${JSON.stringify(greeting.slice(0, 200))}`)
      runner.serving = true
    }

    runner.send(requestFrame(request.staging, request.target))
    const created = await answer()
    if (created.startsWith(FAILED)) throw new RunnerRefusal(created.slice(FAILED.length))
    if (!created.startsWith(READY)) throw runner.unexpected(created)

    try {
      // Deferred, so a synchronous throw from the hook lands in this catch.
      await within(Promise.resolve().then(() => request.beforeWrite?.({ sddl: created.slice(READY.length), holder: runner.pid })))
    } catch (failure) {
      await abort(runner, options.abortGraceMs)
      throw failure
    }

    runner.send(payloadFrame(COMMIT, request.contents.length))
    runner.send(Buffer.from(request.contents))
    const ending = await answer()
    if (ending === PUBLISHED) return
    if (ending.startsWith(FAILED)) throw new RunnerRefusal(ending.slice(FAILED.length))
    throw runner.unexpected(ending)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the runner to discard rather than killing it: only the runner can delete
 * through the handle that owns the file, and its disposition is already armed
 * if it never gets the chance.
 */
async function abort(runner: RunnerProcess, graceMs: number) {
  runner.send(payloadFrame(ABORT, 0))
  const late = Promise.withResolvers<never>()
  const grace = setTimeout(() => late.reject(new RunnerRefusal(`the abort was not acknowledged within ${graceMs}ms`)), graceMs)
  try {
    const answer = await Promise.race([runner.answer(), late.promise])
    if (!answer.startsWith(FAILED)) runner.unexpected(answer)
  } catch (error) {
    runner.discard(error instanceof RunnerRefusal ? error.message : String(error))
  } finally {
    clearTimeout(grace)
  }
}

function referable<Pipe extends object>(pipe: Pipe): pipe is Pipe & { ref(): void; unref(): void } {
  return "ref" in pipe && typeof pipe.ref === "function" && "unref" in pipe && typeof pipe.unref === "function"
}

/** Collapsed and bounded, because it is quoted into an error a user reads. */
function diagnosticSummary(text: string) {
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 300)
}

class RunnerProcess {
  readonly child: ChildProcessWithoutNullStreams
  serving = false
  lost: RunnerRefusal | undefined
  private partial = ""
  private readonly answers: string[] = []
  private waiting: PromiseWithResolvers<string> | undefined
  private diagnostics = ""
  private transportFailure: string | undefined
  // Bun counts a pipe's refs where Node toggles them: a `ref()` on a pipe that
  // is already referenced needs two `unref()`s. Strict alternation is the one
  // sequence both agree on.
  private held = true

  constructor(launch: () => ChildProcessWithoutNullStreams) {
    this.child = launch()
    // The runner writes nothing on stderr but its reason for stopping, which
    // is about the runner, never about a file's contents.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = `${this.diagnostics}${chunk.toString()}`.slice(-2_000)
    })
    // Kept, not discarded: a write that never landed is how a payload gets
    // truncated, and the runner then refuses to publish.
    this.child.stdin.on("error", (error) => {
      this.transportFailure ??= error.message
    })
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk.toString()))
    this.child.on("error", (error) => this.lose(`the interpreter could not be started: ${error.message}`))
    // `close`, not `exit`: every answer the runner flushed has been delivered by
    // then, and a half-written one is dropped with the process.
    this.child.on("close", (code) => {
      const diagnostics = diagnosticSummary(this.diagnostics)
      if (diagnostics) return this.lose(diagnostics)
      if (this.transportFailure) return this.lose(`the payload could not be delivered: ${this.transportFailure}`)
      this.lose(`the runner exited with ${code}`)
    })
    this.idle()
  }

  get pid() {
    return this.child.pid
  }

  answer(): Promise<string> {
    const next = this.answers.shift()
    if (next !== undefined) return Promise.resolve(next)
    if (this.lost) return Promise.reject(this.lost)
    this.waiting = Promise.withResolvers<string>()
    // An answer abandoned to a timeout is rejected later, when the runner is
    // discarded, with nobody left awaiting it.
    this.waiting.promise.catch(() => undefined)
    return this.waiting.promise
  }

  send(bytes: Buffer) {
    if (this.lost) return
    try {
      this.child.stdin.write(bytes)
    } catch (error) {
      this.transportFailure ??= error instanceof Error ? error.message : String(error)
    }
  }

  /** While a request is pending, the runner keeps this process alive. */
  hold() {
    if (this.held) return
    this.held = true
    this.child.ref()
    for (const pipe of this.pipes()) pipe.ref()
  }

  /** An idle runner never does. */
  idle() {
    if (!this.held) return
    this.held = false
    this.child.unref()
    for (const pipe of this.pipes()) pipe.unref()
  }

  discard(reason: string) {
    this.lose(reason)
    this.child.kill()
    return this.lost!
  }

  unexpected(line: string) {
    if (line.startsWith(FATAL)) return this.discard(line.slice(FATAL.length))
    return this.discard(`unexpected answer ${JSON.stringify(line.slice(0, 200))}`)
  }

  /** Bun's stdin has no `ref`, and does not hold the loop. */
  private pipes() {
    return [this.child.stdin, this.child.stdout, this.child.stderr].filter(referable)
  }

  private receive(text: string) {
    this.partial += text
    for (;;) {
      const end = this.partial.indexOf("\n")
      if (end < 0) return
      const line = this.partial.slice(0, end).trim()
      this.partial = this.partial.slice(end + 1)
      const waiting = this.waiting
      this.waiting = undefined
      if (waiting) waiting.resolve(line)
      else this.answers.push(line)
    }
  }

  private lose(reason: string) {
    if (this.lost) return
    this.lost = new RunnerRefusal(reason)
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.reject(this.lost)
  }
}
