import { describe, expect, test } from "bun:test"

import {
  REVIEW_ESTIMATED_ROW_HEIGHT,
  REVIEW_MAX_WINDOW_ROWS,
  REVIEW_WINDOW_MAX_ROW_BUDGET,
  reviewWindowRowBudget,
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

/** Gap segments whose [offset, offset+height) span overlaps [top, bottom). */
function gapsIntersecting(
  segments: ReturnType<typeof segmentsAt>,
  top: number,
  bottom: number,
  rowHeight = 40,
) {
  const intersecting: Array<{ offset: number; height: number }> = []
  let offset = 0
  for (const segment of segments) {
    const height = segment.kind === "gap" ? segment.height : rowHeight
    if (segment.kind === "gap" && offset + height > top && offset < bottom) {
      intersecting.push({ offset, height })
    }
    offset += height
  }
  return intersecting
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

  test("derives the row budget from viewport geometry with bounded floor and ceiling", () => {
    // Exact rule: ceil((viewport + 2*overscan) / estimate) + 2, clamped.
    expect(reviewWindowRowBudget({ viewportHeight: 1200, overscan: 80, estimatedRowHeight: 40 })).toBe(36)
    expect(reviewWindowRowBudget({ viewportHeight: 960, overscan: 80, estimatedRowHeight: 40 })).toBe(30)
    expect(reviewWindowRowBudget({ viewportHeight: 1600, overscan: 80, estimatedRowHeight: 40 })).toBe(46)
    // Short viewports keep the historical minimum window.
    expect(reviewWindowRowBudget({ viewportHeight: 400, overscan: 80, estimatedRowHeight: 40 }))
      .toBe(REVIEW_MAX_WINDOW_ROWS)
    // Unmeasured viewports fall back to the degenerate first window.
    expect(reviewWindowRowBudget({ viewportHeight: 0, overscan: 80, estimatedRowHeight: 40 }))
      .toBe(REVIEW_MAX_WINDOW_ROWS)
    // The ceiling bounds tall viewports and tiny estimates.
    expect(reviewWindowRowBudget({ viewportHeight: 4000, overscan: 80, estimatedRowHeight: 10 }))
      .toBe(REVIEW_WINDOW_MAX_ROW_BUDGET)
    // A zero estimate falls back to the default row height instead of dividing by zero.
    expect(reviewWindowRowBudget({ viewportHeight: 1200, overscan: 80, estimatedRowHeight: 0 }))
      .toBe(reviewWindowRowBudget({ viewportHeight: 1200, overscan: 80, estimatedRowHeight: REVIEW_ESTIMATED_ROW_HEIGHT }))
  })

  test("leaves no gap segment inside tall viewports at the top or after a deep scroll", () => {
    for (const viewportHeight of [960, 1200, 1600]) {
      for (const scrollTop of [0, 350 * 40]) {
        const segments = segmentsAt({ scrollTop, viewportHeight })
        expect(gapsIntersecting(segments, scrollTop, scrollTop + viewportHeight)).toEqual([])
        // Geometry stays exact: rows plus gaps still describe the whole corpus.
        const total = segments.reduce(
          (sum, segment) => sum + (segment.kind === "gap" ? segment.height : 40),
          0,
        )
        expect(total).toBe(500 * 40)
      }
    }
  })

  test("required rows ride on top of the derived budget in tall viewports", () => {
    const segments = segmentsAt({
      scrollTop: 0,
      viewportHeight: 1200,
      required: (item) => item === "src/file-350.ts",
    })
    const rows = rowIndexes(segments)
    expect(rows).toContain(350)
    expect(gapsIntersecting(segments, 0, 1200)).toEqual([])
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
