import type { RetirementResult } from "../../launch"
import type { ACPTransport } from "./transport"

/**
 * How one ACP process learns it is over, and what happens to the processes it
 * owned when it does.
 *
 * The two are one concept because they are one ordering: every path that
 * concludes the process is gone must register retirement before a replacement
 * may be admitted, and every caller racing real work against the process's
 * death must be told by the same reason the transport reported. Splitting them
 * is how a replacement starts over a writer that was never retired.
 */
export type ACPExitGate = {
  /** The first reason this process was declared over, if it has been. */
  readonly reason: Error | undefined
  /** The retirement, if any path has started it. */
  readonly retirement: Promise<RetirementResult | undefined> | undefined
  /** Records the reason without waking anyone: the caller is still tearing down. */
  retain(error: Error): void
  /** Records the reason and rejects everyone waiting on this process. */
  fail(error: Error): void
  /**
   * Rejects when the process dies, and never resolves. Callers race it against
   * the work they are waiting for, so a dead provider settles them with the
   * transport's own reason rather than a timeout.
   */
  waitForExit(): Promise<never>
  /** Memoized: one transport retires once, however many paths reach it. */
  retire(): Promise<RetirementResult | undefined>
  exitMessage(code: number | null, signal: NodeJS.Signals | null): string
  connectionClosedMessage(): string
}

export function createACPExitGate(input: {
  /** Read lazily: the gate exists before the transport it will retire. */
  transport: Pick<ACPTransport, "dispose">
  /** The last line the provider wrote, which is usually the only diagnosis there is. */
  stderr: () => string | undefined
}): ACPExitGate {
  let reason: Error | undefined
  let retirement: Promise<RetirementResult | undefined> | undefined
  let waiters: Array<(error: Error) => void> = []

  const retain = (error: Error) => { reason ??= error }

  return {
    get reason() { return reason },
    get retirement() { return retirement },
    retain,
    fail(error: Error) {
      retain(error)
      const settling = waiters
      waiters = []
      for (const reject of settling) reject(reason!)
    },
    waitForExit() {
      if (reason) return Promise.reject(reason)
      return new Promise<never>((_, reject) => { waiters.push(reject) })
    },
    retire() {
      retirement ??= Promise.resolve(input.transport.dispose() ?? undefined)
      // Whoever started it may not be awaiting it; an unobserved rejection
      // here would take the runtime down.
      void retirement.catch(() => {})
      return retirement
    },
    exitMessage(code, signal) {
      const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
      const last = input.stderr()
      return last ? `ACP transport exited with ${status}: ${last}` : `ACP transport exited with ${status}`
    },
    connectionClosedMessage() {
      const last = input.stderr()
      return last ? `ACP connection closed: ${last}` : "ACP connection closed"
    },
  }
}
