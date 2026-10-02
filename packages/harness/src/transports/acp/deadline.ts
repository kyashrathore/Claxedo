import type { HarnessServices } from "../../contract"
import { AcpTransportError } from "./errors"
import { HoldableCountdown } from "@claxedo/helpers"

export class AcpStartupDeadline {
  private readonly countdown: HoldableCountdown
  private readonly timeout: Promise<never>

  constructor(clock: HarnessServices["clock"], ms: number | undefined, operation: string) {
    let rejectTimeout!: (error: Error) => void
    this.timeout = new Promise((_, reject) => { rejectTimeout = reject })
    this.countdown = new HoldableCountdown(clock, ms ?? 10_000, () => rejectTimeout(new AcpTransportError("timeout", `ACP ${operation} timed out`)))
  }

  async run<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    let abort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new AcpTransportError("connection", "ACP operation was abandoned", signal?.reason))
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
    })
    try { return await Promise.race([work, this.timeout, aborted]) }
    finally { this.countdown.dispose(); signal?.removeEventListener("abort", abort) }
  }

  async request<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.hold()
    try { return await work() }
    finally { release() }
  }

  hold(): () => void { return this.countdown.hold() }
}
