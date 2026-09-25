import type { HarnessServices } from "../../contract"

export class AcpQuiet {
  private phase: "active" | "held" | "expired" | "disposed" = "active"
  private holds = 0
  private timer?: unknown

  constructor(private readonly clock: HarnessServices["clock"], private readonly ms: number,
    private readonly expired: () => void) { this.schedule() }

  touch(): void {
    if (this.phase !== "active") return
    this.clear()
    this.schedule()
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
      if (this.holds === 0 && this.phase === "held") {
        this.phase = "active"
        this.schedule()
      }
    }
  }

  dispose(): void {
    this.phase = "disposed"
    this.clear()
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      this.phase = "expired"
      this.timer = undefined
      this.expired()
    }, this.ms)
  }

  private clear(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }
}
