import type { HarnessServices } from "../../contract"
import { AcpTransportError } from "./errors"
import { HoldableCountdown } from "@claxedo/helpers"

export class AcpStartupDeadline {
  private readonly countdown: HoldableCountdown
  private readonly timeout: Promise<never>

  constructor(clock: HarnessServices["clock"], ms: number, operation: string) {
    let rejectTimeout!: (error: Error) => void
    this.timeout = new Promise((_, reject) => { rejectTimeout = reject })
    this.countdown = new HoldableCountdown(clock, ms, () => rejectTimeout(new AcpTransportError("timeout", `ACP ${operation} timed out`)))
  }

  async run<T>(work: Promise<T>): Promise<T> {
    try { return await Promise.race([work, this.timeout]) }
    finally { this.countdown.dispose() }
  }

  async request<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.hold()
    try { return await work() }
    finally { release() }
  }

  hold(): () => void { return this.countdown.hold() }
}
