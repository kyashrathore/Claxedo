export type CountdownClock = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export class HoldableCountdown {
  private state: "active" | "held" | "expired" | "disposed" = "active"
  private holds = 0
  private timer?: unknown

  constructor(private readonly clock: CountdownClock, private readonly ms: number,
    private readonly expired: () => void) { this.schedule() }

  touch(): void {
    if (this.state !== "active") return
    this.clear()
    this.schedule()
  }

  hold(): () => void {
    if (this.state !== "active" && this.state !== "held") return () => {}
    this.holds++
    this.state = "held"
    this.clear()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
      if (this.holds === 0 && this.state === "held") {
        this.state = "active"
        this.schedule()
      }
    }
  }

  dispose(): void {
    if (this.state === "disposed") return
    this.state = "disposed"
    this.clear()
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      if (this.state !== "active") return
      this.state = "expired"
      this.expired()
    }, this.ms)
  }

  private clear(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }
}
