/**
 * Blank-area analysis for a fast transcript flick.
 *
 * The page driver reports raw geometry per frame — the scroller's visible band
 * and every mounted row's rect — and this module turns that into "how many
 * viewport pixels had no row under them when that frame was painted". Keeping
 * the arithmetic out of `page.evaluate` is what makes it testable: a serialized
 * in-page function cannot be exercised by a unit test.
 */

export type FlickRowGeometry = {
  top: number
  bottom: number
  /** The row has rendered text, or is a deliberately empty spacer row. */
  painted: boolean
}

export type FlickFrameSample = {
  frame: number
  /** Page clock at the top of the frame callback. */
  at: number
  scrollTop: number
  viewportTop: number
  viewportBottom: number
  rows: FlickRowGeometry[]
}

export type FlickFrameAnalysis = {
  frame: number
  scrollTop: number
  blankPx: number
  largestBlankPx: number
  unpaintedPx: number
  /** Mounted rows entirely below the visible band — the forward render band. */
  forwardRows: number
  /** How far past the viewport bottom the mounted rows reach. */
  forwardBandPx: number
  behindRows: number
  /** Forward band, in pixels, that would have covered this frame's unrendered travel. */
  bandPxForSkippedFrames: number
  /** Gap to the previous rendered frame; a multiple of the display interval when frames were skipped. */
  gapMs: number
  /** Display frames the renderer did not produce before this one. */
  skippedFrames: number
  /** Scroll advance since the previous rendered frame. */
  advancePx: number
  /**
   * Viewport pixels with nothing under them on the last frame the compositor
   * presented from the PREVIOUS frame's rows.
   *
   * Zero whenever the renderer produced every display frame: the scroll event
   * and the virtualizer's DOM update run before that frame's paint, so a
   * rendered frame is coherent however far it moved — `blankPx` measures that
   * and stays zero. It is the frames the renderer missed that show the band:
   * the compositor keeps scrolling the layer it already has, so the viewport
   * slides past the mounted rows by the distance it travelled without a new
   * frame, capped at one screen.
   *
   * Derived, not observed: a frame the renderer missed has no callback to
   * sample from, so this interpolates the offset it was presented at from the
   * measured gap and the travel inside it.
   */
  exposedPx: number
}

export type FlickSpeedSummary = {
  /** The requested per-frame scroll advance, the flow's independent variable. */
  pxPerFrame: number
  /** What the gesture actually achieved, from the sampled offsets. */
  observedPxPerFrame: number
  rowsPerFrame: number
  frames: number
  blankFrames: number
  worstBlankPx: number
  meanBlankPx: number
  unpaintedFrames: number
  forwardRowsMin: number
  forwardRowsMedian: number
  forwardBandPxMedian: number
  worstGapMs: number
  skippedFrames: number
  exposedFrames: number
  worstExposedPx: number
  /** Forward rows that would have covered the worst measured stretch of unrendered travel. */
  bandRowsForWorstAdvance: number
}

type Interval = { start: number; end: number }

function clipped(rows: FlickRowGeometry[], top: number, bottom: number): Interval[] {
  return rows
    .map((row) => ({ start: Math.max(row.top, top), end: Math.min(row.bottom, bottom) }))
    .filter((interval) => interval.end - interval.start > 0)
    .sort((left, right) => left.start - right.start)
}

function gaps(intervals: Interval[], top: number, bottom: number): number[] {
  const result: number[] = []
  let cursor = top
  for (const interval of intervals) {
    if (interval.start > cursor) result.push(interval.start - cursor)
    cursor = Math.max(cursor, interval.end)
  }
  if (bottom > cursor) result.push(bottom - cursor)
  return result
}

export function analyzeFlickFrame(sample: FlickFrameSample, previous?: FlickFrameSample): FlickFrameAnalysis {
  const { viewportTop: top, viewportBottom: bottom } = sample
  const blanks = gaps(clipped(sample.rows, top, bottom), top, bottom)
  const unpainted = gaps(clipped(sample.rows.filter((row) => row.painted), top, bottom), top, bottom)
  const advance = previous ? sample.scrollTop - previous.scrollTop : 0
  const priorBand = previous ? forwardBandPx(previous) : 0
  const gapMs = previous ? sample.at - previous.at : 0
  const skipped = Math.max(0, Math.round(gapMs / DISPLAY_INTERVAL_MS) - 1)
  const unrendered = skipped ? (advance * skipped) / (skipped + 1) : 0
  return {
    frame: sample.frame,
    scrollTop: round(sample.scrollTop),
    blankPx: round(blanks.reduce((sum, gap) => sum + gap, 0)),
    largestBlankPx: round(Math.max(0, ...blanks)),
    unpaintedPx: round(unpainted.reduce((sum, gap) => sum + gap, 0)),
    forwardRows: sample.rows.filter((row) => row.top >= bottom).length,
    forwardBandPx: round(forwardBandPx(sample)),
    behindRows: sample.rows.filter((row) => row.bottom <= top).length,
    gapMs: round(gapMs),
    skippedFrames: skipped,
    advancePx: round(advance),
    exposedPx: round(Math.min(Math.max(0, unrendered - priorBand), bottom - top)),
    bandPxForSkippedFrames: round(unrendered),
  }
}

function forwardBandPx(sample: FlickFrameSample) {
  const reach = Math.max(sample.viewportBottom, ...sample.rows.map((row) => row.bottom))
  return Math.max(0, reach - sample.viewportBottom)
}

/**
 * A frame is blank when more than one pixel of the visible band has no row
 * under it. The 1px floor absorbs fractional row rects, which round to a
 * sub-pixel seam between two adjacent rows on a fractional device ratio.
 */
export const FLICK_BLANK_FLOOR_PX = 1

/** 60hz, the rate the harness's headless Chromium presents at. */
const DISPLAY_INTERVAL_MS = 1000 / 60

/** A frame whose scroll advanced by less than this was not part of the flick. */
const FLICK_MOVING_FLOOR_PX = 1

/**
 * The frames the flick owns: from the frame before the scroller first moved to
 * `settleFrames` after the last one it moved on, the rest discarded.
 *
 * The frame BEFORE the first advance is kept because every per-frame figure
 * here is a comparison with the previous frame — without it the flick's first
 * advance, and whatever it exposed, is scored as no movement at all.
 *
 * The sampler is armed before the gesture and drained after it, and the
 * gesture's own start and stop latency leaves idle frames at both ends —
 * scoring them would divide the blank area by however long the harness took to
 * get the gesture going, and the settle frames are kept because the recovery
 * paint is the part the user reports as "rows render as I arrive".
 */
export function flickWindow(samples: FlickFrameSample[], settleFrames: number): FlickFrameSample[] {
  const moving = samples
    .map((sample, index) => ({ index, delta: sample.scrollTop - (samples[index - 1]?.scrollTop ?? sample.scrollTop) }))
    .filter((entry) => Math.abs(entry.delta) >= FLICK_MOVING_FLOOR_PX)
    .map((entry) => entry.index)
  if (!moving.length) return []
  return samples.slice(
    Math.max(0, moving[0] - 1),
    Math.min(samples.length, moving[moving.length - 1] + 1 + settleFrames),
  )
}

/**
 * The distance the flick advanced per DISPLAY frame.
 *
 * Travel over elapsed time, not the median gap between rendered frames: a
 * rendered frame that arrives late carries the travel of the frames the
 * renderer missed with it, so a per-rendered-frame median reads a stalling
 * renderer as a faster flick.
 */
export function flickObservedPxPerFrame(samples: FlickFrameSample[]): number {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last) return 0
  const elapsed = last.at - first.at
  if (elapsed <= 0) return 0
  return round((Math.abs(last.scrollTop - first.scrollTop) / elapsed) * DISPLAY_INTERVAL_MS)
}

export function summarizeFlickSpeed(input: {
  pxPerFrame: number
  observedPxPerFrame: number
  meanRowPx?: number
  frames: FlickFrameAnalysis[]
}): FlickSpeedSummary {
  const blanks = input.frames.map((frame) => frame.blankPx)
  const forward = input.frames.map((frame) => frame.forwardRows).sort((left, right) => left - right)
  const band = input.frames.map((frame) => frame.forwardBandPx).sort((left, right) => left - right)
  const gaps = input.frames.map((frame) => frame.gapMs)
  const exposed = input.frames.map((frame) => frame.exposedPx)
  const needed = Math.max(0, ...input.frames.map((frame) => frame.bandPxForSkippedFrames))
  return {
    pxPerFrame: round(input.pxPerFrame),
    observedPxPerFrame: round(input.observedPxPerFrame),
    rowsPerFrame: input.meanRowPx ? round(input.observedPxPerFrame / input.meanRowPx) : 0,
    frames: input.frames.length,
    blankFrames: blanks.filter((value) => value > FLICK_BLANK_FLOOR_PX).length,
    worstBlankPx: round(Math.max(0, ...blanks)),
    meanBlankPx: round(blanks.reduce((sum, value) => sum + value, 0) / Math.max(1, blanks.length)),
    unpaintedFrames: input.frames.filter((frame) => frame.unpaintedPx > FLICK_BLANK_FLOOR_PX).length,
    forwardRowsMin: forward[0] ?? 0,
    forwardRowsMedian: forward[Math.floor(forward.length / 2)] ?? 0,
    forwardBandPxMedian: band[Math.floor(band.length / 2)] ?? 0,
    worstGapMs: round(Math.max(0, ...gaps)),
    skippedFrames: input.frames.reduce((sum, frame) => sum + frame.skippedFrames, 0),
    exposedFrames: exposed.filter((value) => value > FLICK_BLANK_FLOOR_PX).length,
    worstExposedPx: round(Math.max(0, ...exposed)),
    bandRowsForWorstAdvance: input.meanRowPx ? Math.ceil(needed / input.meanRowPx) : 0,
  }
}

/** Renderer cost of the frames the flick produced, from the flow's own recorder. */
export type FlickCost = {
  p95FrameMs: number
  worstFrameMs: number
  framesOver1667: number
}

export function flickTable(summaries: Array<FlickSpeedSummary & { cost?: FlickCost }>): string {
  const columns: Array<[string, (summary: FlickSpeedSummary & { cost?: FlickCost }) => string | number]> = [
    ["px/frame asked", (summary) => summary.pxPerFrame],
    ["px/frame observed", (summary) => summary.observedPxPerFrame],
    ["rows/frame observed", (summary) => summary.rowsPerFrame],
    ["rendered frames", (summary) => summary.frames],
    ["blank frames", (summary) => summary.blankFrames],
    ["worst blank px", (summary) => summary.worstBlankPx],
    ["unpainted frames", (summary) => summary.unpaintedFrames],
    ["forward rows min/median", (summary) => `${summary.forwardRowsMin}/${summary.forwardRowsMedian}`],
    ["forward band px", (summary) => summary.forwardBandPxMedian],
    ["skipped frames", (summary) => summary.skippedFrames],
    ["worst gap ms", (summary) => summary.worstGapMs],
    ["exposed frames", (summary) => summary.exposedFrames],
    ["worst exposed px", (summary) => summary.worstExposedPx],
    ["band rows for worst advance", (summary) => summary.bandRowsForWorstAdvance],
    ["p95 task ms", (summary) => summary.cost ? round(summary.cost.p95FrameMs) : "-"],
    ["worst task ms", (summary) => summary.cost ? round(summary.cost.worstFrameMs) : "-"],
    ["tasks >16.67ms", (summary) => summary.cost ? summary.cost.framesOver1667 : "-"],
  ]
  const row = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`
  return [
    row(columns.map(([label]) => label)),
    row(columns.map(() => "---")),
    ...summaries.map((summary) => row(columns.map(([, read]) => read(summary)))),
  ].join("\n")
}

function round(value: number) {
  return Math.round(value * 10) / 10
}
