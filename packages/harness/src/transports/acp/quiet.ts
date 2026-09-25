import type { HarnessServices } from "../../contract"
import { HoldableCountdown } from "@claxedo/helpers"

export class AcpQuiet {
  private readonly countdown: HoldableCountdown

  constructor(clock: HarnessServices["clock"], ms: number,
    expired: () => void) { this.countdown = new HoldableCountdown(clock, ms, expired) }

  touch(): void { this.countdown.touch() }

  hold(): () => void { return this.countdown.hold() }

  dispose(): void { this.countdown.dispose() }
}
