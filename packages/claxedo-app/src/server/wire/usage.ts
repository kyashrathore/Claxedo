import { isRecord } from "@claxedo/helpers/guards"
import type { MachineTimeResponse } from "@claxedo/usage-contract"
import { contractMismatch } from "../errors"
import type { MachineTime, UsageSummary } from "../usage-types"

const MACHINE_TIME_FIELDS = ["since", "until", "activeMs", "running"] as const satisfies readonly (keyof MachineTimeResponse)[]

function isMachineTime(value: unknown): value is MachineTimeResponse {
  return isRecord(value) && MACHINE_TIME_FIELDS.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]))
}

export function machineTimeFromWire(body: unknown): MachineTime {
  if (!isMachineTime(body)) throw contractMismatch("machine time")
  return { since: body.since, until: body.until, activeMs: body.activeMs, running: body.running }
}

function isUsageSummary(value: unknown): value is UsageSummary {
  return isRecord(value) && value.version === 1 && isRecord(value.range) && isRecord(value.quota) && isRecord(value.claxedo) && isRecord(value.filterOptions)
}

export function usageSummaryFromWire(body: unknown): UsageSummary {
  if (!isUsageSummary(body)) throw contractMismatch("usage")
  return body
}
