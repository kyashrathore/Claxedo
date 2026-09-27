import { singleFlightUntil } from "@claxedo/helpers"
import type { Run } from "@cursor/sdk"

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

  readonly cancel = singleFlightUntil(async () => {
    this.cancellationRequested = true
    this.cancelling = true
    try {
      await this.ready.promise
      if (this.active.state === "running") await this.active.run.cancel()
    } finally { this.cancelling = false }
  }, () => true)
}
