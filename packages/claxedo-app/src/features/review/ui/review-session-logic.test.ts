import { describe, expect, test } from "bun:test"
import {
  changedLineCount,
  diffId,
  diffTestId,
  diffTriggerTestId,
  exceedsDiffLimit,
  expandOrCollapseAll,
  groupCommentsByFile,
  hasDiffContent,
  isReviewDiff,
  MAX_DIFF_CHANGED_LINES,
  reviewDiffList,
  sameReviewList,
  sameReviewSet,
} from "./review-session-logic"

// Pure decision logic behind the canonical session-review surface.

const baseDiff = { file: "a.ts", additions: 1, deletions: 2 }

describe("review memo equality", () => {
  test("compares sets by membership", () => {
    expect(sameReviewSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true)
    expect(sameReviewSet(new Set(["a"]), new Set(["b"]))).toBe(false)
  })

  test("compares ordered lists by reference", () => {
    const item = { id: "a" }
    expect(sameReviewList([item], [item])).toBe(true)
    expect(sameReviewList([item], [{ id: "a" }])).toBe(false)
  })
})

describe("isReviewDiff", () => {
  test("accepts a minimal well-formed diff", () => {
    expect(isReviewDiff(baseDiff)).toBe(true)
  })

  test("rejects non-objects, arrays, and missing numeric fields", () => {
    expect(isReviewDiff(null)).toBe(false)
    expect(isReviewDiff([baseDiff])).toBe(false)
    expect(isReviewDiff({ file: "a.ts", additions: 1 })).toBe(false)
    expect(isReviewDiff({ file: 1, additions: 1, deletions: 1 })).toBe(false)
  })

  test("rejects a bad status but accepts a known one", () => {
    expect(isReviewDiff({ ...baseDiff, status: "bogus" })).toBe(false)
    expect(isReviewDiff({ ...baseDiff, status: "modified" })).toBe(true)
  })

  test("rejects wrong-typed patch/before/after fields", () => {
    expect(isReviewDiff({ ...baseDiff, patch: 5 })).toBe(false)
    expect(isReviewDiff({ ...baseDiff, before: {} })).toBe(false)
  })
})

describe("reviewDiffList", () => {
  test("passes an all-valid array through unchanged", () => {
    const arr = [baseDiff, { file: "b.ts", additions: 0, deletions: 0 }]
    expect(reviewDiffList(arr)).toEqual(arr)
  })

  test("filters out invalid entries from a mixed array", () => {
    const arr = [baseDiff, { nope: true }]
    expect(reviewDiffList(arr)).toEqual([baseDiff])
  })

  test("wraps a single diff into a one-element list", () => {
    expect(reviewDiffList(baseDiff)).toEqual([baseDiff])
  })

  test("collects valid values from a keyed object", () => {
    expect(reviewDiffList({ x: baseDiff, y: { bad: 1 } })).toEqual([baseDiff])
  })

  test("returns empty for nullish/primitive input", () => {
    expect(reviewDiffList(null)).toEqual([])
    expect(reviewDiffList(7)).toEqual([])
  })
})

describe("hasDiffContent", () => {
  test("true when a patch or before/after string is present", () => {
    expect(hasDiffContent({ ...baseDiff, patch: "@@" })).toBe(true)
    expect(hasDiffContent({ ...baseDiff, before: "x" })).toBe(true)
    expect(hasDiffContent({ ...baseDiff, after: "y" })).toBe(true)
  })

  test("false when none of patch/before/after is a string", () => {
    expect(hasDiffContent(baseDiff)).toBe(false)
  })
})

describe("changedLineCount", () => {
  test("sums additions and deletions", () => {
    expect(changedLineCount({ additions: 40, deletions: 2 })).toBe(42)
  })
})

describe("exceedsDiffLimit", () => {
  test("gates an expanded, unforced, non-media diff above the ceiling", () => {
    expect(exceedsDiffLimit({ changedLines: 501, expanded: true, forced: false, media: false })).toBe(true)
  })

  test("does not gate at or below the ceiling", () => {
    expect(
      exceedsDiffLimit({ changedLines: MAX_DIFF_CHANGED_LINES, expanded: true, forced: false, media: false }),
    ).toBe(false)
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

describe("expandOrCollapseAll", () => {
  test("collapses to empty when anything is open", () => {
    expect(expandOrCollapseAll(["a.ts"], ["a.ts", "b.ts"])).toEqual([])
  })

  test("opens every file when nothing is open", () => {
    expect(expandOrCollapseAll([], ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"])
  })
})

describe("groupCommentsByFile", () => {
  test("buckets comments by file preserving insertion order", () => {
    const comments = [
      { file: "a.ts", id: "1" },
      { file: "b.ts", id: "2" },
      { file: "a.ts", id: "3" },
    ]
    const grouped = groupCommentsByFile(comments)
    expect(grouped.get("a.ts")).toEqual([
      { file: "a.ts", id: "1" },
      { file: "a.ts", id: "3" },
    ])
    expect(grouped.get("b.ts")).toEqual([{ file: "b.ts", id: "2" }])
  })

  test("undefined input yields an empty map", () => {
    expect(groupCommentsByFile(undefined).size).toBe(0)
  })
})

describe("diff DOM ids", () => {
  test("diffId is a stable prefixed checksum and derived ids append suffixes", () => {
    const id = diffId("src/a.ts")
    expect(id).toStartWith("session-review-diff-")
    expect(diffTestId("src/a.ts")).toBe(`${id}-item`)
    expect(diffTriggerTestId("src/a.ts")).toBe(`${id}-trigger`)
  })

  test("different files yield different ids", () => {
    expect(diffId("src/a.ts")).not.toBe(diffId("src/b.ts"))
  })
})
