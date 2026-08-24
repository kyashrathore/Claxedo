/**
 * Windowed materialization for the Review file list.
 *
 * The review model can hold hundreds of changed files, but the DOM only ever
 * needs a viewport's worth of header rows: mounting all of them is where the
 * multi-hundred-millisecond style/layout tasks came from, at first open and —
 * once a disposed panel rebuilds on resume — on every resume. Rows outside the
 * window are replaced by fixed-height gap divs so scroll geometry (and the
 * scrollbar) still describe the whole corpus.
 *
 * Diff *content* is a different layer and already windowed: expanded bodies
 * mount lazily and @pierre/diffs windows the visible lines. This module only
 * decides which header rows exist at all.
 */

/**
 * Minimum viewport-window row budget, and the window size when the viewport
 * cannot be measured yet. Required rows (anchor, focus) add to the budget.
 */
export const REVIEW_MAX_WINDOW_ROWS = 20

/** Fallback row height until a real row has been measured. */
export const REVIEW_ESTIMATED_ROW_HEIGHT = 40

/**
 * Hard ceiling on the derived row budget: even a very tall viewport with a
 * small measured row height never materializes more header rows than this.
 */
export const REVIEW_WINDOW_MAX_ROW_BUDGET = 64

/**
 * The one owner of the row-budget rule: enough rows to tile the overscanned
 * viewport with zero gap segments inside it, bounded on both sides. A span of
 * length L intersects at most ceil(L / h) + 1 rows of height h (partial rows
 * at both edges); one more row absorbs measured rows slightly under the
 * estimate. A fixed budget smaller than this leaves blank gap DOM visible in
 * tall viewports — twenty 40px rows cover only 800px.
 */
export function reviewWindowRowBudget(input: {
  viewportHeight: number
  overscan: number
  estimatedRowHeight: number
}) {
  if (input.viewportHeight <= 0) return REVIEW_MAX_WINDOW_ROWS
  const estimate = input.estimatedRowHeight > 0 ? input.estimatedRowHeight : REVIEW_ESTIMATED_ROW_HEIGHT
  const span = input.viewportHeight + 2 * Math.max(0, input.overscan)
  const covering = Math.ceil(span / estimate) + 2
  return Math.min(REVIEW_WINDOW_MAX_ROW_BUDGET, Math.max(REVIEW_MAX_WINDOW_ROWS, covering))
}

export type ReviewWindowSegment<T> =
  | { kind: "row"; item: T; index: number }
  | { kind: "gap"; height: number; count: number }

export function reviewWindowSegments<T>(input: {
  items: readonly T[]
  scrollTop: number
  viewportHeight: number
  /** Extra pixels materialized above and below the viewport. */
  overscan: number
  estimatedRowHeight: number
  measuredHeight: (item: T, index: number) => number | undefined
  /** Rows that must exist regardless of the window (scroll anchor, focus). */
  required: (item: T, index: number) => boolean
  /** Overrides the geometry-derived budget (reviewWindowRowBudget). */
  maxRows?: number
}): ReviewWindowSegment<T>[] {
  const maxRows = Math.max(1, input.maxRows ?? reviewWindowRowBudget(input))
  const estimate = input.estimatedRowHeight > 0 ? input.estimatedRowHeight : REVIEW_ESTIMATED_ROW_HEIGHT
  // No measurable viewport yet (first render, or a non-laying-out test DOM):
  // materialize the first window's worth so the surface is never empty.
  const degenerate = input.viewportHeight <= 0
  const top = input.scrollTop - input.overscan
  const bottom = input.scrollTop + input.viewportHeight + input.overscan

  const segments: ReviewWindowSegment<T>[] = []
  let offset = 0
  let windowRows = 0
  let gapHeight = 0
  let gapCount = 0
  const flushGap = () => {
    if (gapCount === 0) return
    segments.push({ kind: "gap", height: gapHeight, count: gapCount })
    gapHeight = 0
    gapCount = 0
  }

  for (let index = 0; index < input.items.length; index++) {
    const item = input.items[index]!
    const height = input.measuredHeight(item, index) ?? estimate
    const inWindow = degenerate
      ? windowRows < maxRows
      : offset + height > top && offset < bottom && windowRows < maxRows
    if (inWindow || input.required(item, index)) {
      flushGap()
      segments.push({ kind: "row", item, index })
      if (inWindow) windowRows++
    } else {
      gapHeight += height
      gapCount++
    }
    offset += height
  }
  flushGap()
  return segments
}

export function reviewWindowRowCount(segments: readonly ReviewWindowSegment<unknown>[]) {
  return segments.reduce((count, segment) => segment.kind === "row" ? count + 1 : count, 0)
}
