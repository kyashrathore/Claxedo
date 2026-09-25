import type { HarnessServices } from "../../contract"
import { AcpTransportError } from "./errors"

export class AcpStartupDeadline {
  private phase: "active" | "held" | "expired" | "settled" = "active"
  private holds = 0
  private handle?: unknown
  private readonly timeout: Promise<never>

  constructor(private readonly clock: HarnessServices["clock"], private readonly ms: number, operation: string) {
    this.timeout = new Promise((_, reject) => {
      this.expire = () => { this.phase = "expired"; reject(new AcpTransportError("timeout", `ACP ${operation} timed out`)) }
    })
    this.schedule()
  }

  private expire: () => void = () => {}

  async run<T>(work: Promise<T>): Promise<T> {
    try { return await Promise.race([work, this.timeout]) }
    finally { this.phase = "settled"; this.clear() }
  }

  async request<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.hold()
    try { return await work() }
    finally { release() }
  }

  hold(): () => void {
    if (this.phase !== "active" && this.phase !== "held") return () => {}
    this.holds++
    this.phase = "held"
    this.clear()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
      if (this.holds === 0 && this.phase === "held") { this.phase = "active"; this.schedule() }
    }
  }

  private schedule(): void { this.handle = this.clock.setTimeout(this.expire, this.ms) }

  private clear(): void {
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle)
    this.handle = undefined
  }
}
