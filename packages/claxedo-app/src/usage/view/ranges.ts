import type { UsageDays } from "../model"
import type { Choice } from "./choices"

export type RangeChoice = "7" | "30" | "90"

export const RANGES: readonly Choice<RangeChoice>[] = [
  { value: "7", label: "usage.range.7" },
  { value: "30", label: "usage.range.30" },
  { value: "90", label: "usage.range.90" },
]

const DAYS: Readonly<Record<RangeChoice, UsageDays>> = { "7": 7, "30": 30, "90": 90 }

export function rangeDays(choice: RangeChoice): UsageDays {
  return DAYS[choice]
}
