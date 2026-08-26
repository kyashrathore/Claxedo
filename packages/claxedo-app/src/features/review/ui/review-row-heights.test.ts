import { describe, expect, test } from "bun:test"

import { createReviewRowHeights } from "./review-row-heights"

describe("review row heights", () => {
  test("never answers for an expansion state it has not measured", () => {
    const heights = createReviewRowHeights()
    heights.record("src/a.ts", false, 40)

    expect(heights.get("src/a.ts", false)).toBe(40)
    expect(heights.get("src/a.ts", true)).toBeUndefined()
  })

  test("keeps both states of one row side by side", () => {
    const heights = createReviewRowHeights()
    heights.record("src/a.ts", false, 40)
    heights.record("src/a.ts", true, 3880)

    expect(heights.get("src/a.ts", false)).toBe(40)
    expect(heights.get("src/a.ts", true)).toBe(3880)
  })

  test("reports whether a measurement moved, so the window only recomputes when it did", () => {
    const heights = createReviewRowHeights()

    expect(heights.record("src/a.ts", false, 40)).toBe(true)
    expect(heights.record("src/a.ts", false, 40.2)).toBe(false)
    expect(heights.record("src/a.ts", false, 48)).toBe(true)
    // The same height in the other state is new information, not a repeat.
    expect(heights.record("src/a.ts", true, 48)).toBe(true)
  })

  test("has no height for a file it has never seen", () => {
    const heights = createReviewRowHeights()

    expect(heights.get("src/missing.ts", false)).toBeUndefined()
    expect(heights.get("src/missing.ts", true)).toBeUndefined()
  })
})
