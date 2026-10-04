import { defaultRangeExtractor, type Range } from "@tanstack/solid-virtual"
import type { TimelineRow } from "./timeline-row-model"

export function timelineRenderIndexes(input: {
  rows: readonly TimelineRow.TimelineRow[]
  activeMessageId: string | undefined
  pinned: readonly number[]
  range: Range
  overscan: number
}) {
  const active = input.activeMessageId ? input.rows.findLastIndex((row) => row.userMessageId === input.activeMessageId) : -1
  return [...new Set([...input.pinned, ...defaultRangeExtractor({ ...input.range, overscan: input.overscan }), ...(active < 0 ? [] : [active])])]
    .filter((index) => index >= 0 && index < input.range.count)
    .sort((a, b) => a - b)
}
