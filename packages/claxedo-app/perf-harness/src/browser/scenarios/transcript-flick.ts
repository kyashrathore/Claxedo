import {
  analyzeFlickFrame,
  flickTable,
  summarizeFlickSpeed,
  type FlickCost,
  type FlickSpeedSummary,
} from "../../flick-blank"
import type { FlowResult } from "../../flows"
import { measureInteraction } from "../../frame-sampler"
import { measurement } from "../../isolated-interaction"
import type { Measurement } from "../../types"
import { loadTranscriptWindow, measureTranscriptFlick, positionForFlick } from "../actions/flick"
import { launchTo } from "../actions/common"
import { recordVisualFailure } from "../actions/common"
import { waitForTranscript } from "../actions/session"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { FrameMetric } from "../../frame-sampler"
import type { Page } from "playwright-core"

const FLICK_FRAMES = 20
const FLICK_SETTLE_FRAMES = 6
const FLICK_MIN_ROWS = 240
const FLICK_MAX_PAGE_BATCHES = 40
const FLICK_START_FRACTION = 0.35
/**
 * Per-frame scroll advance, in CSS pixels: an ordinary flick, then doubling.
 * Rows per frame would look more natural and is the wrong knob — the mean row
 * height a band mounts changes WITH the band, so a rows-per-frame axis moves
 * the flick speed between the runs it is meant to compare.
 */
const DEFAULT_SPEEDS = [700, 1_400, 2_800, 5_600]

function speeds() {
  const configured = (process.env.CLAXEDO_PERF_FLICK_PX_PER_FRAME ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
  return configured.length ? configured : DEFAULT_SPEEDS
}

function cost(metric: FrameMetric): FlickCost {
  return {
    p95FrameMs: metric.p95FrameMs,
    worstFrameMs: metric.worstFrameMs,
    framesOver1667: metric.framesOver1667,
  }
}

/**
 * D20: blank regions during a fast flick.
 *
 * The render band is the virtualizer's overscan, in rows. This flow reports,
 * per flick speed, how much of the viewport had no mounted row under it on the
 * frames the flick produced, and what those frames cost the renderer — so the
 * band is chosen from the speed it actually survives rather than from the row
 * count someone expected to be enough. `forward rows` is the band the run
 * observed, so a report labels its own band; re-measuring another band means
 * rebuilding the app with that constant and running this flow again.
 */
export async function transcriptFlick(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const session = fixture.sessions[0]
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  const window = await loadTranscriptWindow(page, { minRows: FLICK_MIN_ROWS, maxBatches: FLICK_MAX_PAGE_BATCHES })
  if (window.rows < FLICK_MIN_ROWS) {
    recordVisualFailure(
      fixture,
      `transcript flick paged in only ${window.rows} of ${FLICK_MIN_ROWS} rows in ${window.batches} batches; the flick has no transcript to traverse`,
    )
  }

  const summaries: Array<FlickSpeedSummary & { cost?: FlickCost }> = []
  const debug: Measurement[] = [
    measurement("flick_loaded_rows", window.rows, "count"),
    measurement("flick_mean_row_px", Math.round(window.meanRowPx), "px"),
    measurement("flick_scroll_height_px", Math.round(window.scrollHeight), "px"),
  ]
  let headline: FrameMetric | undefined

  for (const pxPerFrame of speeds()) {
    let run: Awaited<ReturnType<typeof measureTranscriptFlick>> | undefined
    const start = await positionForFlick(page, {
      pxPerFrame,
      frames: FLICK_FRAMES,
      startFraction: FLICK_START_FRACTION,
    })
    const metric = await measureInteraction(page, `transcript-flick-${pxPerFrame}`, async () => {
      run = await measureTranscriptFlick(page, {
        pxPerFrame,
        frames: FLICK_FRAMES,
        settleFrames: FLICK_SETTLE_FRAMES,
        start,
      })
    })
    if (!run) throw new Error(`transcript flick at ${pxPerFrame}px/frame produced no samples`)
    if (!run.samples.length) {
      recordVisualFailure(fixture, `transcript flick at ${pxPerFrame}px/frame never moved the scroller in ${run.sampledFrames} sampled frames`)
    }
    const frames = run.samples.map((sample, index) => analyzeFlickFrame(sample, run?.samples[index - 1]))
    const summary = summarizeFlickSpeed({
      pxPerFrame,
      observedPxPerFrame: run.observedPxPerFrame,
      meanRowPx: window.mountedMeanRowPx,
      frames,
    })
    summaries.push({ ...summary, cost: cost(metric) })
    debug.push(
      measurement(`flick_${pxPerFrame}_blank_frames`, summary.blankFrames, "count"),
      measurement(`flick_${pxPerFrame}_worst_blank_px`, summary.worstBlankPx, "px"),
      measurement(`flick_${pxPerFrame}_exposed_frames`, summary.exposedFrames, "count"),
      measurement(`flick_${pxPerFrame}_worst_exposed_px`, summary.worstExposedPx, "px"),
      measurement(`flick_${pxPerFrame}_skipped_frames`, summary.skippedFrames, "count"),
      measurement(`flick_${pxPerFrame}_forward_rows_min`, summary.forwardRowsMin, "count"),
      measurement(`flick_${pxPerFrame}_forward_band_px`, summary.forwardBandPxMedian, "px"),
      measurement(`flick_${pxPerFrame}_observed_px_per_frame`, summary.observedPxPerFrame, "px"),
      measurement(`flick_${pxPerFrame}_travel_px`, run.travelPx, "px"),
      measurement(`flick_${pxPerFrame}_sampled_frames`, run.sampledFrames, "count"),
    )
    headline = metric
  }

  console.log(
    [
      `transcript-flick: ${window.rows} rows loaded in ${window.batches} page-up batches (${window.growth.join("/")}), mean row ${Math.round(window.meanRowPx)}px, mounted mean ${Math.round(window.mountedMeanRowPx)}px, scroll height ${Math.round(window.scrollHeight)}px`,
      flickTable(summaries),
    ].join("\n"),
  )
  if (!headline) throw new Error("transcript flick measured no speeds")
  return { headline, debug }
}
