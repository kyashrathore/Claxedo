import { describe, expect, test } from "bun:test"

import {
  REVIEW_DIFF_LINE_HEIGHT,
  REVIEW_ESTIMATED_ROW_HEIGHT,
  REVIEW_MAX_WINDOW_ROWS,
  REVIEW_WINDOW_MAX_ROW_BUDGET,
  createReviewWindowSegments,
  reviewExpandedRowHeight,
  reviewWindowRowBudget,
  reviewWindowRowCount,
  reviewWindowRowHeight,
  reviewWindowSegments,
  sameReviewWindowSegments,
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
    rowHeight: input.measured ?? (() => 40),
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

  test("keeps row wrappers identical across recomputes so <For> reconciles instead of rebuilding", () => {
    const window = createReviewWindowSegments<string>()
    const input = (scrollTop: number) => ({
      items,
      scrollTop,
      viewportHeight: 400,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => 40,
      required: () => false,
    })

    const first = window(input(0))
    const second = window(input(0))

    expect(sameReviewWindowSegments(first, second)).toBe(true)
    expect(second).not.toBe(first)
    for (let index = 0; index < first.length; index++) {
      expect(second[index]).toBe(first[index])
    }
  })

  test("keeps the rows that survive a scroll and replaces only what moved", () => {
    const window = createReviewWindowSegments<string>()
    const input = (scrollTop: number) => ({
      items,
      scrollTop,
      viewportHeight: 400,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => 40,
      required: () => false,
    })

    const before = window(input(0))
    const after = window(input(120))

    expect(sameReviewWindowSegments(before, after)).toBe(false)
    const beforeRows = new Map(
      before.flatMap((segment) => (segment.kind === "row" ? [[segment.index, segment] as const] : [])),
    )
    const shared = after.filter((segment) => segment.kind === "row" && beforeRows.get(segment.index) === segment)
    // The window moved by three rows, so most of it is the very same objects.
    expect(shared.length).toBeGreaterThan(0)
    // The trailing gap shrank, so it is a fresh wrapper with the new height.
    const gap = after.at(-1)!
    expect(gap.kind).toBe("gap")
    expect(before.at(-1)).not.toBe(gap)
  })

  test("re-creates a row wrapper when its index moves, and forgets rows that left the window", () => {
    const window = createReviewWindowSegments<string>()
    const base = {
      scrollTop: 0,
      viewportHeight: 400,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => 40,
      required: () => false,
    }

    const before = window({ ...base, items })
    const shifted = window({ ...base, items: ["src/inserted.ts", ...items] })

    const beforeFirst = before.find((segment) => segment.kind === "row" && segment.item === "src/file-0.ts")
    const afterFirst = shifted.find((segment) => segment.kind === "row" && segment.item === "src/file-0.ts")
    expect(afterFirst).toBeDefined()
    // file-0 slid from index 0 to index 1: a different row, so a fresh wrapper.
    expect(afterFirst).not.toBe(beforeFirst)

    // Scrolling far away and back gives a fresh wrapper: the DOM went with it.
    const away = window({ ...base, items, scrollTop: 350 * 40 })
    expect(away.some((segment) => segment.kind === "row" && segment.item === "src/file-0.ts")).toBe(false)
    const returned = window({ ...base, items })
    expect(returned.find((segment) => segment.kind === "row" && segment.item === "src/file-0.ts"))
      .not.toBe(before.find((segment) => segment.kind === "row" && segment.item === "src/file-0.ts"))
  })

  test("a stabilized window still describes the same geometry as the pure function", () => {
    const window = createReviewWindowSegments<string>()
    const input = {
      items,
      scrollTop: 350 * 40,
      viewportHeight: 960,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => 40,
      required: (item: string) => item === "src/file-10.ts",
    }
    window(input)
    const stabilized = window(input)
    const pure = reviewWindowSegments(input)

    expect(stabilized).toEqual(pure)
    expect(reviewWindowRowCount(stabilized)).toBe(reviewWindowRowCount(pure))
  })

  test("materializes everything when the corpus fits the window", () => {
    const few = reviewWindowSegments({
      items: items.slice(0, 6),
      scrollTop: 0,
      viewportHeight: 400,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => 40,
      required: () => false,
    })
    expect(rowIndexes(few)).toEqual([0, 1, 2, 3, 4, 5])
    expect(few.some((segment) => segment.kind === "gap")).toBe(false)
  })

  test("materializes one first-fold's worth of height, not of rows, before a viewport exists", () => {
    // The state a panel reopen restores: every row expanded, nothing measured.
    const expanded = reviewExpandedRowHeight({ changedLines: 192, collapsedHeight: 40 })
    const segments = reviewWindowSegments({
      items,
      scrollTop: 0,
      viewportHeight: 0,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => expanded,
      required: () => false,
    })
    const rows = rowIndexes(segments)
    expect(rows).toEqual([0])
    expect(segments.some((segment) => segment.kind === "gap")).toBe(true)
  })

  test("still fills the degenerate window with collapsed rows", () => {
    const segments = reviewWindowSegments({
      items,
      scrollTop: 0,
      viewportHeight: 0,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => 40,
      required: () => false,
    })
    expect(reviewWindowRowCount(segments)).toBe(REVIEW_MAX_WINDOW_ROWS)
  })

  test("keeps an expanded row out of a measured window it cannot fit in", () => {
    const expanded = (changedLines: number) => reviewExpandedRowHeight({ changedLines, collapsedHeight: 40 })
    const segments = reviewWindowSegments({
      items,
      scrollTop: 0,
      viewportHeight: 800,
      overscan: 80,
      estimatedRowHeight: 40,
      rowHeight: () => expanded(192),
      required: () => false,
    })
    expect(rowIndexes(segments)).toEqual([0])
  })

  test("projects an expanded row from its own changed-line count", () => {
    expect(reviewExpandedRowHeight({ changedLines: 0, collapsedRowHeight: 40 }))
      .toBe(40 + REVIEW_DIFF_LINE_HEIGHT)
    expect(reviewExpandedRowHeight({ changedLines: 10, collapsedRowHeight: 40 }))
      .toBe(40 + 10 * REVIEW_DIFF_LINE_HEIGHT)
    expect(reviewExpandedRowHeight({ changedLines: 10, collapsedRowHeight: 0 }))
      .toBe(REVIEW_ESTIMATED_ROW_HEIGHT + 10 * REVIEW_DIFF_LINE_HEIGHT)
  })
})

describe("review window row height", () => {
  const collapsedEstimate = 72

  test("uses a measurement taken in the row's current expansion state", () => {
    expect(reviewWindowRowHeight({
      measured: { height: 71, expanded: false },
      expanded: false,
      collapsedEstimate,
      changedLines: 192,
    })).toBe(71)
    expect(reviewWindowRowHeight({
      measured: { height: 4800, expanded: true },
      expanded: true,
      collapsedEstimate,
      changedLines: 192,
    })).toBe(4800)
  })

  test("a just-expanded row is estimated from its diff, not from its collapsed height", () => {
    const height = reviewWindowRowHeight({
      measured: { height: 71, expanded: false },
      expanded: true,
      collapsedEstimate,
      changedLines: 192,
    })
    expect(height).toBe(71 + 192 * REVIEW_DIFF_LINE_HEIGHT)
    // The point of the estimate: one expanded row no longer fits beside a
    // viewport's worth of siblings, so Expand All cannot materialize them all.
    expect(height!).toBeGreaterThan(960)
  })

  test("a just-collapsed row drops its expanded measurement instead of keeping it", () => {
    expect(reviewWindowRowHeight({
      measured: { height: 4800, expanded: true },
      expanded: false,
      collapsedEstimate,
      changedLines: 192,
    })).toBeUndefined()
  })

  test("an expanded row with no measurement at all falls back to the collapsed estimate", () => {
    expect(reviewWindowRowHeight({
      measured: undefined,
      expanded: true,
      collapsedEstimate,
      changedLines: 4,
    })).toBe(collapsedEstimate + 4 * REVIEW_DIFF_LINE_HEIGHT)
  })

  test("expand-all materializes one screenful of diffs, not one screenful of headers", () => {
    const diffs = Array.from({ length: 24 }, (_, index) => ({ file: `src/file-${index}.ts`, changedLines: 192 }))
    const measured = new Map(diffs.map((diff) => [diff.file, { height: 71, expanded: false }] as const))
    const segmentsFor = (expanded: boolean) => reviewWindowSegments({
      items: diffs,
      scrollTop: 0,
      viewportHeight: 862,
      overscan: 80,
      estimatedRowHeight: collapsedEstimate,
      rowHeight: (diff) => reviewWindowRowHeight({
        measured: measured.get(diff.file),
        expanded,
        collapsedEstimate,
        changedLines: diff.changedLines,
      }),
      required: () => false,
    })

    const collapsed = reviewWindowRowCount(segmentsFor(false))
    const expandedRows = reviewWindowRowCount(segmentsFor(true))
    expect(collapsed).toBeGreaterThan(10)
    expect(expandedRows).toBe(1)
  })
})
