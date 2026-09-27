/// <reference types="bun" />
import { expect, test } from "bun:test"
import { timelineRenderIndexes } from "./timeline-render-range"
import { TimelineRow } from "./timeline-row-model"

const turn = (userMessageId: string) => [
  TimelineRow.UserMessage({ userMessageId, anchor: true }),
  TimelineRow.Thinking({ userMessageId }),
  TimelineRow.Retry({ userMessageId }),
  TimelineRow.TurnFold({ userMessageId, foldCount: 2, folded: true, opening: false }),
]
const rows = [...turn("u1"), ...turn("u2"), ...turn("u3")]
const range = { startIndex: 0, endIndex: 1, overscan: 0, count: rows.length }

test("the active turn's last row renders while the reader is scrolled away from it", () => {
  expect(timelineRenderIndexes({ rows, activeMessageId: "u3", pinned: [], range, overscan: 1 })).toEqual([0, 1, 2, 11])
})

test("with no active turn only the visible range, its overscan and the pinned rows render", () => {
  expect(timelineRenderIndexes({ rows, activeMessageId: undefined, pinned: [6], range, overscan: 1 })).toEqual([0, 1, 2, 6])
})
