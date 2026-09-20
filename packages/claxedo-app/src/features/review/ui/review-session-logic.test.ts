import { describe, expect, test } from "bun:test"
import {
  diffTriggerTestId,
  exceedsDiffLimit,
  MAX_DIFF_CHANGED_LINES,
} from "./review-session-logic"

// Pure decision logic behind the review surface.

describe("exceedsDiffLimit", () => {
  test("gates an expanded, unforced, non-media diff above the ceiling", () => {
    expect(exceedsDiffLimit({ changedLines: 501, expanded: true, forced: false, media: false })).toBe(true)
  })

  test("does not gate at or below the ceiling", () => {
    expect(exceedsDiffLimit({ changedLines: MAX_DIFF_CHANGED_LINES, expanded: true, forced: false, media: false })).toBe(
      false,
    )
  })

  test("forcing 'render anyway' always renders", () => {
    expect(exceedsDiffLimit({ changedLines: 9999, expanded: true, forced: true, media: false })).toBe(false)
  })

  test("media files and collapsed diffs are never gated", () => {
    expect(exceedsDiffLimit({ changedLines: 9999, expanded: true, forced: false, media: true })).toBe(false)
    expect(exceedsDiffLimit({ changedLines: 9999, expanded: false, forced: false, media: false })).toBe(false)
  })

  test("honors a custom limit", () => {
    expect(exceedsDiffLimit({ changedLines: 11, expanded: true, forced: false, media: false, limit: 10 })).toBe(true)
  })
})

describe("diff trigger ids", () => {
  test("is a stable checksum of the path", () => {
    expect(diffTriggerTestId("src/a.ts")).toStartWith("session-review-diff-")
    expect(diffTriggerTestId("src/a.ts")).toEndWith("-trigger")
    expect(diffTriggerTestId("src/a.ts")).toBe(diffTriggerTestId("src/a.ts"))
  })

  test("different files yield different ids", () => {
    expect(diffTriggerTestId("src/a.ts")).not.toBe(diffTriggerTestId("src/b.ts"))
  })
})
