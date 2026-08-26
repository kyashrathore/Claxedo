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
 * The last collapsed row height any review surface measured.
 *
 * A collapsed row's height is a property of the review row's CSS, not of a
 * mount, but the budget below is derived from it — so a surface that starts
 * from the coarse constant materializes one window's worth of rows, measures a
 * real row, derives a LARGER budget, and materializes a second wave inside the
 * same frame. That doubled construction is paid on every rebuild (panel
 * reopen, workspace retarget). Carrying the measurement across mounts makes
 * the first budget the right one; it is still only an estimate, and a mount
 * that measures something different overwrites it.
 */
let measuredReviewRowHeight = REVIEW_ESTIMATED_ROW_HEIGHT

/** The row-height estimate a new review surface should start from. */
export function reviewEstimatedRowHeight() {
  return measuredReviewRowHeight
}

/** Record a freshly measured collapsed row height for later mounts. */
export function rememberReviewRowHeight(height: number) {
  if (height > 0) measuredReviewRowHeight = height
}

/**
 * Rendered height of one diff line, and the smallest body a diff can occupy.
 *
 * @pierre/diffs gives every rendered line the same height and sizes an
 * expanded file's container to the WHOLE diff — it windows which lines exist
 * inside that box, not how tall the box is — so the box a row is about to
 * occupy is its line count times this. Kept beside the row-height estimate
 * because it serves the same question: how tall is a row the DOM has not
 * measured yet.
 */
export const REVIEW_DIFF_LINE_HEIGHT = 24

/** A row height, and the expansion state the row was in when it was measured. */
export type ReviewMeasuredRowHeight = { height: number; expanded: boolean }

/**
 * The one owner of "how tall does the window think this row is".
 *
 * A measurement counts only while the row is still in the expansion state it
 * was taken in, so toggling a row invalidates its measurement in the same
 * update that toggles it and the window is recomputed from the new heights
 * before anything mounts. Expand All then materializes the one diff that fits
 * instead of a viewport's worth it is about to throw away, and Collapse All
 * refills the list in one pass instead of admitting one row per frame as each
 * newly materialized row gets remeasured.
 *
 * `undefined` means "no usable measurement": the caller's collapsed estimate
 * applies, which is right for a row that has just collapsed.
 */
export function reviewWindowRowHeight(input: {
  measured?: ReviewMeasuredRowHeight
  expanded: boolean
  collapsedEstimate: number
  changedLines: number
}): number | undefined {
  if (input.measured?.expanded === input.expanded) return input.measured.height
  if (!input.expanded) return undefined
  return reviewExpandedRowHeight({
    collapsedRowHeight: input.measured?.height ?? input.collapsedEstimate,
    changedLines: input.changedLines,
  })
}

/**
 * Height to expect from a row that is expanded but has never been measured
 * expanded.
 *
 * Heights are only ever *sampled* from collapsed rows (an expanded diff is
 * hundreds of lines tall and would shrink the budget to a single row), so
 * until this the window had no expanded estimate at all: a row that had just
 * been expanded still measured one header tall, the window believed a whole
 * viewport of diffs would fit, and Expand All mounted every one of them —
 * full @pierre/diffs shadow trees, style and layout for all of them — only for
 * the next frame's remeasure to drop all but the one that actually fits.
 *
 * The diff's own changed-line count answers it without measuring anything.
 * The estimate errs SMALL by construction (split style renders the two sides
 * side by side, so a change of N lines occupies at most N rows), and erring
 * small is the safe direction: it admits one row too many rather than leaving
 * a gap where a row should be.
 */
export function reviewExpandedRowHeight(input: {
  collapsedRowHeight: number
  changedLines: number
  lineHeight?: number
}) {
  const lineHeight = input.lineHeight ?? REVIEW_DIFF_LINE_HEIGHT
  const collapsed = input.collapsedRowHeight > 0 ? input.collapsedRowHeight : REVIEW_ESTIMATED_ROW_HEIGHT
  return collapsed + Math.max(1, input.changedLines) * lineHeight
}

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
export function reviewWindowRowBudget(input: { viewportHeight: number; overscan: number; estimatedRowHeight: number }) {
  if (input.viewportHeight <= 0) return REVIEW_MAX_WINDOW_ROWS
  const estimate = input.estimatedRowHeight > 0 ? input.estimatedRowHeight : REVIEW_ESTIMATED_ROW_HEIGHT
  const span = input.viewportHeight + 2 * Math.max(0, input.overscan)
  const covering = Math.ceil(span / estimate) + 2
  return Math.min(REVIEW_WINDOW_MAX_ROW_BUDGET, Math.max(REVIEW_MAX_WINDOW_ROWS, covering))
}

export type ReviewWindowRowSegment<T> = { kind: "row"; item: T; index: number }
export type ReviewWindowGapSegment = { kind: "gap"; height: number; count: number }
export type ReviewWindowSegment<T> = ReviewWindowRowSegment<T> | ReviewWindowGapSegment

export function reviewWindowSegments<T>(input: {
  items: readonly T[]
  scrollTop: number
  viewportHeight: number
  /** Extra pixels materialized above and below the viewport. */
  overscan: number
  estimatedRowHeight: number
  /**
   * The row's known height: measured where a mount has measured one, projected
   * where the row's materialized size is knowable in advance (an expanded row).
   * `undefined` falls back to `estimatedRowHeight`, the collapsed height.
   */
  rowHeight: (item: T, index: number) => number | undefined
  /** Rows that must exist regardless of the window (scroll anchor, focus). */
  required: (item: T, index: number) => boolean
  /** Overrides the geometry-derived budget (reviewWindowRowBudget). */
  maxRows?: number
}): ReviewWindowSegment<T>[] {
  const maxRows = Math.max(1, input.maxRows ?? reviewWindowRowBudget(input))
  const estimate = input.estimatedRowHeight > 0 ? input.estimatedRowHeight : REVIEW_ESTIMATED_ROW_HEIGHT
  // No measurable viewport yet (first render, or a non-laying-out test DOM):
  // materialize the first window's worth so the surface is never empty. That
  // "worth" is a budget of rows AND of the height those rows stand for — a row
  // projected to be a whole screen tall is not one twentieth of a first fold,
  // and treating it as one is what put twenty expanded diffs in the frame the
  // reopened panel's data arrives in.
  const degenerate = input.viewportHeight <= 0
  const degenerateSpan = maxRows * estimate
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
    const height = input.rowHeight(item, index) ?? estimate
    const inWindow = degenerate
      ? windowRows < maxRows && offset < degenerateSpan
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
  return segments.reduce((count, segment) => (segment.kind === "row" ? count + 1 : count), 0)
}

/**
 * Two segment lists describe the same materialization when they hold the same
 * segment objects in the same order. Paired with `createReviewWindowSegments`
 * below this is a *content* comparison, so a recompute that lands on the same
 * window (the common case: a scroll tick that moves less than a row, or a row
 * remeasure that does not move the window) stops at the memo instead of
 * notifying `<For>` and the `data-review-rendered-files` attribute.
 */
export function sameReviewWindowSegments<T>(
  a: readonly ReviewWindowSegment<T>[],
  b: readonly ReviewWindowSegment<T>[],
) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/**
 * The one owner of review row *identity*.
 *
 * `<For>` reconciles by reference, so the segment object is what decides
 * whether a materialized row keeps its DOM (its Accordion.Item, its sticky
 * header and — for an expanded file — the whole @pierre/diffs shadow tree) or
 * is disposed and re-created. `reviewWindowSegments` is a pure function and
 * necessarily allocates fresh wrappers, which made every recompute of the
 * window rebuild the entire materialized corpus even when the window itself
 * had not moved.
 *
 * This factory owns one caller's previous window and hands back the *same*
 * wrapper for a row that is still materialized at the same index, and the same
 * gap wrapper for a gap of unchanged height and count. Rows that leave the
 * window are dropped (their DOM is gone, so their identity is worthless), and
 * gaps that change size get a fresh wrapper so the scroll spacer updates.
 *
 * Identity is per `key(item)` — the changed file's path — not per item object.
 * A review item is a value record that the model REPLACES whenever anything
 * about the file changes, and the common change is the one that matters most
 * here: the file's diff content arriving after the row was already mounted.
 * Keying on the object made exactly that moment dispose the row and rebuild
 * it, which is the teardown this factory exists to prevent. The reused wrapper
 * carries the newest item, so a caller reading `segment.item` after the key
 * matched still sees current content.
 */
export function createReviewWindowSegments<T>(key: (item: T) => string) {
  let rows = new Map<string, ReviewWindowRowSegment<T>>()
  let gaps: ReviewWindowGapSegment[] = []

  return (input: Parameters<typeof reviewWindowSegments<T>>[0]): ReviewWindowSegment<T>[] => {
    const segments = reviewWindowSegments(input)
    const nextRows = new Map<string, ReviewWindowRowSegment<T>>()
    const nextGaps: ReviewWindowGapSegment[] = []

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!
      if (segment.kind === "row") {
        const id = key(segment.item)
        const previous = rows.get(id)
        const stable = previous?.index === segment.index ? previous : segment
        stable.item = segment.item
        nextRows.set(id, stable)
        segments[index] = stable
        continue
      }
      const previous = gaps[nextGaps.length]
      const stable = previous?.height === segment.height && previous.count === segment.count ? previous : segment
      nextGaps.push(stable)
      segments[index] = stable
    }

    rows = nextRows
    gaps = nextGaps
    return segments
  }
}
