/// <reference types="bun" />
import { expect, test } from "bun:test"
import { resolveTranscriptTypography } from "@/ui/utils"
import { estimateTimelineRowSize, fixedRowHeights } from "./timeline-virtualization"

const rows = [{ _tag: "UserMessage" }, { _tag: "TurnFold" }, { _tag: "TurnGap" }]
const estimate = (index: number, fixed = fixedRowHeights(resolveTranscriptTypography({ pairing: "default" }))) =>
  estimateTimelineRowSize({ index, rows, parts: () => [], fixed })

test("a turn gap and a turn fold are estimated at the height the shipped typography draws them", () => {
  expect([estimate(1), estimate(2)]).toEqual([33, 24])
})

test("a turn gap and a turn fold follow the typography's turn gap and tool row height", () => {
  const fixed = fixedRowHeights(resolveTranscriptTypography({ pairing: "default", turnGap: 40, toolRowHeight: 28 }))
  expect([estimate(1, fixed), estimate(2, fixed)]).toEqual([29, 40])
})
