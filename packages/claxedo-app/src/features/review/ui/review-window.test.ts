import { describe, expect, test } from "bun:test"

import {
  REVIEW_MAX_WINDOW_ROWS,
  reviewWindowRowCount,
  reviewWindowSegments,
} from "./review-window"

const items = Array.from({ length: 500 }, (_, index) => `src/file-${index}.ts`)

function segmentsAt(input: {
  scrollTop: number
  viewportHeight?: number
  required?: (item: string) => boolean
  measured?: (item: string) => number | undefined
}) {
  return reviewWindowSegments({
    items,
    scrollTop: input.scrollTop,
    viewportHeight: input.viewportHeight ?? 400,
    overscan: 80,
    estimatedRowHeight: 40,
    measuredHeight: input.measured ?? (() => 40),
    required: input.required ?? (() => false),
  })
}

function rowIndexes(segments: ReturnType<typeof segmentsAt>) {
  return segments.flatMap((segment) => segment.kind === "row" ? [segment.index] : [])
}

describe("review window segments", () => {
  test("materializes only the viewport window out of a large corpus", () => {
    const segments = segmentsAt({ scrollTop: 0 })
    const rows = rowIndexes(segments)

    expect(rows[0]).toBe(0)
    expect(rows.length).toBeLessThanOrEqual(REVIEW_MAX_WINDOW_ROWS)
    // Everything else is one trailing gap that preserves total height.
    const gaps = segments.filter((segment) => segment.kind === "gap")
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.count).toBe(500 - rows.length)
    expect(gaps[0]!.height).toBe((500 - rows.length) * 40)
  })

  test("follows the scroll position to a deep neighborhood", () => {
    const segments = segmentsAt({ scrollTop: 350 * 40 })
    const rows = rowIndexes(segments)

    expect(rows).toContain(350)
    expect(rows.length).toBeLessThanOrEqual(REVIEW_MAX_WINDOW_ROWS)
    // A leading gap and a trailing gap bracket the window.
    expect(segments[0]!.kind).toBe("gap")
    expect(segments.at(-1)!.kind).toBe("gap")
    const total = segments.reduce(
      (sum, segment) => sum + (segment.kind === "gap" ? segment.height : 40),
      0,
    )
    expect(total).toBe(500 * 40)
  })

  test("materializes required rows outside the window, splitting the gap", () => {
    const segments = segmentsAt({
      scrollTop: 0,
      required: (item) => item === "src/file-350.ts",
    })
    const rows = rowIndexes(segments)

    expect(rows).toContain(350)
    // The required row does not consume window budget.
    expect(rows.filter((index) => index < 100).length).toBeGreaterThan(0)
    const gaps = segments.filter((segment) => segment.kind === "gap")
    expect(gaps.length).toBe(2)
  })

  test("uses measured heights when present so deep offsets stay accurate", () => {
    const measured = (item: string) => item === "src/file-0.ts" ? 4000 : 40
    const segments = segmentsAt({ scrollTop: 4000, measured })
    const rows = rowIndexes(segments)

    // With file-0 measured at 4000px, scrollTop 4000 sits at file-1.
    expect(rows).toContain(1)
    expect(rows).not.toContain(300)
  })

  test("falls back to the first window when the viewport cannot be measured", () => {
    const segments = segmentsAt({ scrollTop: 0, viewportHeight: 0 })
    const rows = rowIndexes(segments)

    expect(rows[0]).toBe(0)
    expect(rows.length).toBe(REVIEW_MAX_WINDOW_ROWS)
    expect(reviewWindowRowCount(segments)).toBe(REVIEW_MAX_WINDOW_ROWS)
  })

  test("materializes everything when the corpus fits the window", () => {
    const few = reviewWindowSegments({
      items: items.slice(0, 6),
      scrollTop: 0,
      viewportHeight: 400,
      overscan: 80,
      estimatedRowHeight: 40,
      measuredHeight: () => 40,
      required: () => false,
    })
    expect(rowIndexes(few)).toEqual([0, 1, 2, 3, 4, 5])
    expect(few.some((segment) => segment.kind === "gap")).toBe(false)
  })
})
