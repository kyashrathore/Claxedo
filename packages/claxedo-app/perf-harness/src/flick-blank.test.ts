import { expect, test } from "bun:test"
import {
  analyzeFlickFrame,
  flickObservedPxPerFrame,
  flickTable,
  flickWindow,
  summarizeFlickSpeed,
  type FlickFrameSample,
} from "./flick-blank"

function sample(input: Partial<FlickFrameSample> & Pick<FlickFrameSample, "rows">): FlickFrameSample {
  return {
    frame: 0,
    at: 0,
    scrollTop: 0,
    viewportTop: 100,
    viewportBottom: 1_000,
    ...input,
  }
}

test("a fully covered band reports no blank pixels", () => {
  const analysis = analyzeFlickFrame(sample({
    frame: 3,
    scrollTop: 4_000,
    rows: [
      { top: -50, bottom: 400, painted: true },
      { top: 400, bottom: 1_200, painted: true },
      { top: 1_200, bottom: 1_600, painted: true },
    ],
  }))

  expect(analysis).toEqual({
    frame: 3,
    scrollTop: 4_000,
    blankPx: 0,
    largestBlankPx: 0,
    unpaintedPx: 0,
    forwardRows: 1,
    forwardBandPx: 600,
    behindRows: 0,
    gapMs: 0,
    skippedFrames: 0,
    advancePx: 0,
    exposedPx: 0,
    bandPxForSkippedFrames: 0,
  })
})

test("a band the mounted rows run out under reports the uncovered pixels", () => {
  const analysis = analyzeFlickFrame(sample({
    frame: 7,
    scrollTop: 8_000,
    rows: [
      { top: 60, bottom: 300, painted: true },
      { top: 300, bottom: 520, painted: true },
    ],
  }))

  expect(analysis.blankPx).toBe(480)
  expect(analysis.largestBlankPx).toBe(480)
  expect(analysis.forwardRows).toBe(0)
  expect(analysis.forwardBandPx).toBe(0)
})

test("gaps between mounted rows are counted separately from the trailing gap", () => {
  const analysis = analyzeFlickFrame(sample({
    rows: [
      { top: 100, bottom: 300, painted: true },
      { top: 500, bottom: 800, painted: true },
    ],
  }))

  expect(analysis.blankPx).toBe(400)
  expect(analysis.largestBlankPx).toBe(200)
})

test("a mounted row waiting for its content is unpainted, not blank", () => {
  const analysis = analyzeFlickFrame(sample({
    rows: [
      { top: 100, bottom: 600, painted: true },
      { top: 600, bottom: 1_100, painted: false },
    ],
  }))

  expect(analysis.blankPx).toBe(0)
  expect(analysis.unpaintedPx).toBe(400)
})

test("an advance the previous frame's forward band covered exposes nothing", () => {
  const previous = sample({ frame: 1, at: 16, scrollTop: 0, rows: [{ top: 100, bottom: 1_800, painted: true }] })
  const analysis = analyzeFlickFrame(
    sample({ frame: 2, at: 32, scrollTop: 700, rows: [{ top: 100, bottom: 1_800, painted: true }] }),
    previous,
  )

  expect(analysis.advancePx).toBe(700)
  expect(analysis.gapMs).toBe(16)
  expect(analysis.exposedPx).toBe(0)
})

test("a rendered frame is coherent however far it moved: only skipped frames expose the band", () => {
  const rows = [{ top: 100, bottom: 1_300, painted: true }]
  const oneFrame = analyzeFlickFrame(
    sample({ frame: 2, at: 33, scrollTop: 5_000, rows }),
    sample({ frame: 1, at: 16, scrollTop: 0, rows }),
  )

  expect(oneFrame.skippedFrames).toBe(0)
  expect(oneFrame.exposedPx).toBe(0)

  // 50ms gap: two of the three display frames came from the previous frame's
  // rows, the later of them 2/3 of the way through a 900px advance.
  const skipped = analyzeFlickFrame(
    sample({ frame: 2, at: 66, scrollTop: 900, rows }),
    sample({ frame: 1, at: 16, scrollTop: 0, rows }),
  )

  expect(skipped.skippedFrames).toBe(2)
  expect(skipped.bandPxForSkippedFrames).toBe(600)
  expect(skipped.exposedPx).toBe(300)
})

test("exposure is capped at the viewport: a longer stall cannot blank more than the screen", () => {
  const rows = [{ top: 100, bottom: 1_000, painted: true }]
  const analysis = analyzeFlickFrame(
    sample({ frame: 2, at: 116, scrollTop: 20_000, rows }),
    sample({ frame: 1, at: 16, scrollTop: 0, rows }),
  )

  expect(analysis.exposedPx).toBe(900)
})

test("the flick window starts at the first moving frame and keeps the settle frames", () => {
  const samples = [0, 0, 0, 500, 1_000, 1_500, 1_500, 1_500, 1_500, 1_500].map((scrollTop, index) =>
    sample({ frame: index, at: index * 16, scrollTop, rows: [] })
  )

  const window = flickWindow(samples, 2)

  expect(window.map((entry) => entry.frame)).toEqual([2, 3, 4, 5, 6, 7])
  // 1500px of travel over frames 2..7, which is 80ms of a 16ms page clock.
  expect(flickObservedPxPerFrame(window)).toBe(312.5)
})

test("a flick that never moved yields no window", () => {
  expect(flickWindow([sample({ rows: [] }), sample({ frame: 1, rows: [] })], 3)).toEqual([])
})

test("the speed summary counts blank and exposed frames, and the band the worst advance needed", () => {
  const frames = [
    { frame: 1, scrollTop: 0, blankPx: 0.5, largestBlankPx: 0.5, unpaintedPx: 0, forwardRows: 6, forwardBandPx: 1_100, behindRows: 4, bandPxForSkippedFrames: 0, gapMs: 16, skippedFrames: 0, advancePx: 800, exposedPx: 0 },
    { frame: 2, scrollTop: 960, blankPx: 240, largestBlankPx: 240, unpaintedPx: 0, forwardRows: 1, forwardBandPx: 300, behindRows: 5, bandPxForSkippedFrames: 2_400, gapMs: 50, skippedFrames: 2, advancePx: 3_600, exposedPx: 1_300 },
    { frame: 3, scrollTop: 1_920, blankPx: 600, largestBlankPx: 600, unpaintedPx: 120, forwardRows: 0, forwardBandPx: 0, behindRows: 5, bandPxForSkippedFrames: 450, gapMs: 33, skippedFrames: 1, advancePx: 900, exposedPx: 450 },
  ]

  const summary = summarizeFlickSpeed({ pxPerFrame: 1_000, observedPxPerFrame: 960, meanRowPx: 200, frames })

  expect(summary).toEqual({
    pxPerFrame: 1_000,
    observedPxPerFrame: 960,
    rowsPerFrame: 4.8,
    frames: 3,
    blankFrames: 2,
    worstBlankPx: 600,
    meanBlankPx: 280.2,
    unpaintedFrames: 1,
    forwardRowsMin: 0,
    forwardRowsMedian: 1,
    forwardBandPxMedian: 300,
    worstGapMs: 50,
    skippedFrames: 3,
    exposedFrames: 2,
    worstExposedPx: 1_300,
    bandRowsForWorstAdvance: 12,
  })
})

test("the table prints one row per measured speed, and says so when cost is absent", () => {
  const table = flickTable([
    { ...summarizeFlickSpeed({ pxPerFrame: 700, observedPxPerFrame: 480, frames: [] }), cost: { p95FrameMs: 7.24, worstFrameMs: 19.1, framesOver1667: 2 } },
    summarizeFlickSpeed({ pxPerFrame: 1_400, observedPxPerFrame: 960, frames: [] }),
  ])

  const rows = table.split("\n")
  expect(rows).toHaveLength(4)
  expect(rows[0]).toStartWith("| px/frame asked | px/frame observed | rows/frame observed |")
  expect(rows[2]).toStartWith("| 700 | 480 | 0 |")
  expect(rows[2]).toEndWith("| 7.2 | 19.1 | 2 |")
  expect(rows[3]).toEndWith("| - | - | - |")
})
