import { isRecord } from "@claxedo/helpers/guards"
import { contractMismatch } from "../errors"
import type { UsageSummary } from "../usage-types"

function isUsageSummary(value: unknown): value is UsageSummary {
  return isRecord(value) && value.version === 1 && isRecord(value.range) && isRecord(value.quota) && isRecord(value.claxedo) && isRecord(value.filterOptions)
}

export function usageSummaryFromWire(body: unknown): UsageSummary {
  if (!isUsageSummary(body)) throw contractMismatch("usage")
  return body
}
