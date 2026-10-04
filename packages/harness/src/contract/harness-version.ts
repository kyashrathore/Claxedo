import type { SessionBroker } from "./broker"
import { harnessVersionTooOld, harnessVersionUnreadable, type TransportErrorKind } from "./errors"

export type HarnessVersionRange = { readonly transport: TransportErrorKind; readonly program: string; readonly min: string; readonly max: string }

const order = (left: string, right: string) => left.localeCompare(right, "en", { numeric: true })

export function harnessVersionStanding(range: HarnessVersionRange, reported: unknown): "tested" | "newer" {
  if (typeof reported !== "string" || !/^\d+\.\d+\.\d+$/.test(reported)) throw harnessVersionUnreadable(range, reported)
  if (order(reported, range.min) < 0) throw harnessVersionTooOld(range, reported)
  return order(reported, range.max) > 0 ? "newer" : "tested"
}

export class HarnessVersionGate {
  private reportedNewer = false

  constructor(private readonly range: HarnessVersionRange, private readonly source: string) {}

  async admit(reported: unknown, method: string, broker: Pick<SessionBroker, "publish">): Promise<void> {
    if (harnessVersionStanding(this.range, reported) === "tested" || this.reportedNewer) return
    this.reportedNewer = true
    await broker.publish({ type: "diagnostic", diagnostic: { code: `${this.range.transport}.untested_version`, severity: "warn", source: this.source, method,
      message: `${this.range.program} ${String(reported)} is newer than ${this.range.max}, the newest version Claxedo is tested against` } })
  }
}
