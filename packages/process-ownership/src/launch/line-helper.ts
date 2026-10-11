import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { loopHold } from "@claxedo/helpers/process"

/**
 * What one answer line means for the request it answers. `undefined` is a line
 * in no form the program writes, after which nothing it says can be placed.
 */
export type HelperAnswer<T> = { value: T } | { refusal: string } | undefined

export type LineHelperOptions = {
  /** How errors name the helper, for example "process table reader". */
  name: string
  launch: () => ChildProcessWithoutNullStreams
}

type Pending = {
  subject: string
  bounded: boolean
  settled: boolean
  answer(line: string): boolean
  reject(error: Error): void
}

/**
 * Talks to one long-lived helper process that answers each request line with
 * one line, in the order the requests were sent. A helper that exits is
 * replaced on the next request.
 *
 * `timeoutMs` bounds one request. A request past it is rejected, and the helper
 * is discarded unless an unbounded request is waiting on it: that caller's own
 * deadline ends the process doing the asking, and killing the helper would
 * turn a slow machine into a failed request for it too.
 */
export function createLineHelper(options: LineHelperOptions) {
  let current: HelperProcess | undefined

  return {
    ask<T>(request: string, subject: string, timeoutMs: number, interpret: (line: string) => HelperAnswer<T>): Promise<T> {
      if (!current || current.lost) current = new HelperProcess(options)
      return current.ask(request, subject, timeoutMs, interpret)
    },
    /** Lets the helper exit once it has answered everything already asked. */
    release() {
      current?.release()
      current = undefined
    },
  }
}

class HelperProcess {
  lost: Error | undefined
  private readonly name: string
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending: Pending[] = []
  private partial = ""
  private diagnostics = ""
  private readonly loop: ReturnType<typeof loopHold>

  constructor(options: LineHelperOptions) {
    this.name = options.name
    this.child = options.launch()
    this.loop = loopHold(this.child)
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = `${this.diagnostics}${chunk.toString()}`.slice(-2_000)
    })
    this.child.stdin.on("error", (error) => this.lose(`the ${this.name} stopped taking requests: ${error.message}`))
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk.toString()))
    this.child.on("error", (error) => this.lose(`the ${this.name} could not be started: ${error.message}`))
    this.child.on("close", (code, signal) => {
      const diagnostics = this.diagnostics.replaceAll(/\s+/g, " ").trim().slice(0, 300)
      this.lose(diagnostics || `the ${this.name} exited (code ${String(code)}, signal ${String(signal)})`)
    })
    this.loop.idle()
  }

  ask<T>(request: string, subject: string, timeoutMs: number, interpret: (line: string) => HelperAnswer<T>): Promise<T> {
    if (this.lost) return Promise.reject(this.lost)
    const answer = Promise.withResolvers<T>()
    const pending: Pending = {
      subject,
      bounded: timeoutMs > 0,
      settled: false,
      answer: (line) => {
        const meaning = interpret(line)
        if (!meaning) return false
        this.settle(pending, () => "value" in meaning ? answer.resolve(meaning.value) : answer.reject(new Error(meaning.refusal)))
        return true
      },
      reject: answer.reject,
    }
    this.pending.push(pending)
    this.loop.hold()
    if (pending.bounded) {
      // Referenced: Bun on Windows never fires an unreferenced timer that is
      // the loop's only work, and a wedged helper is exactly that case.
      const timer = setTimeout(() => this.expire(pending, timeoutMs), timeoutMs)
      void answer.promise.then(() => clearTimeout(timer), () => clearTimeout(timer))
    }
    this.child.stdin.write(`${request}\n`)
    return answer.promise
  }

  release() {
    this.child.stdin.end()
  }

  private expire(pending: Pending, timeoutMs: number) {
    if (pending.settled) return
    const reason = new Error(`the ${this.name} did not answer for ${pending.subject} within ${timeoutMs}ms`)
    if (this.pending.some((other) => !other.bounded && !other.settled)) return this.settle(pending, () => pending.reject(reason))
    this.discard(reason.message)
  }

  private receive(text: string) {
    this.partial += text
    for (let end = this.partial.indexOf("\n"); end >= 0 && !this.lost; end = this.partial.indexOf("\n")) {
      const line = this.partial.slice(0, end).trim()
      this.partial = this.partial.slice(end + 1)
      const pending = this.pending.shift()
      if (!pending) return this.discard(`the ${this.name} answered a request nobody sent: ${line.slice(0, 200)}`)
      if (!pending.answer(line)) {
        this.pending.unshift(pending)
        return this.discard(`the ${this.name} answered in an unexpected form: ${line.slice(0, 200)}`)
      }
    }
    if (!this.pending.length) this.loop.idle()
  }

  private settle(pending: Pending, outcome: () => void) {
    if (pending.settled) return
    pending.settled = true
    outcome()
  }

  private discard(reason: string) {
    this.lose(reason)
    this.child.kill()
  }

  private lose(reason: string) {
    if (this.lost) return
    this.lost = new Error(reason)
    for (const pending of this.pending.splice(0)) this.settle(pending, () => pending.reject(this.lost!))
    this.loop.idle()
  }
}
