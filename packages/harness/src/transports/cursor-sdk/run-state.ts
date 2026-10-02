import { singleFlightUntil } from "@claxedo/helpers"
import type { Run } from "@cursor/sdk"
import type { HostSteerOutcome } from "./protocol"

type ActiveRun = { state: "starting" } | { state: "running"; run: Run } | { state: "terminal" }

export class CursorRunState {
  private active: ActiveRun = { state: "starting" }
  private readonly ready = Promise.withResolvers<void>()
  private cancellationRequested = false
  private cancelling = false

  get releasable(): boolean { return this.active.state === "terminal" && !this.cancelling }

  beforeSend(): void {
    if (this.cancellationRequested) throw new Error("Cursor run cancelled before send")
  }

  activate(run: Run): void {
    this.active = { state: "running", run }
    this.ready.resolve()
  }

  finish(): void {
    this.active = { state: "terminal" }
    this.ready.resolve()
  }

  async steer(text: string): Promise<HostSteerOutcome> {
    if (this.active.state !== "running") return "no_run"
    return this.active.run.steer ? this.active.run.steer(text) : "unsupported"
  }

  readonly cancel = singleFlightUntil(async () => {
    this.cancellationRequested = true
    this.cancelling = true
    try {
      await this.ready.promise
      if (this.active.state === "running") await this.active.run.cancel()
    } finally { this.cancelling = false }
  }, () => true)
}
