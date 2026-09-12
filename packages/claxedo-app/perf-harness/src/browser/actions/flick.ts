import { flickObservedPxPerFrame, flickWindow, type FlickFrameSample } from "../../flick-blank"
import type { Page } from "playwright-core"

const TIMELINE_CONTENT = "[data-session-timeline-root] [data-timeline-virtual-content]"

declare global {
  interface Window {
    /**
     * The per-frame geometry sampler this module installs for the duration of
     * one flick. The gesture is driven from the Node side over CDP, so the
     * sampler has to outlive the `page.evaluate` call that arms it.
     */
    __claxedoFlickSampler?: { stop: () => FlickFrameSample[] }
  }
}

export type TranscriptWindow = {
  rows: number
  /** Scroll height over row count: every row, measured or still estimated. */
  meanRowPx: number
  /** Mean height of the rows actually mounted, which is what a band's rows cost. */
  mountedMeanRowPx: number
  scrollHeight: number
  batches: number
  /** Row count after each page-up hop, so a short window shows where it stopped growing. */
  growth: number[]
}

/**
 * Page older turns in until the timeline stops growing.
 *
 * The first fold is one turn (`view=latest-surface`), so a long transcript is
 * something the harness has to walk up to. `history-window.ts` loads the next
 * page only from a `scroll` event that lands within 200px of the top while a
 * gesture is marked, and reveals 8 turns at a time — hence the wheel before
 * each hop (a bare `scrollTop` write is not a gesture) and the hop away from
 * the top before each return to it (assigning the offset it already has fires
 * no event at all).
 */
export async function loadTranscriptWindow(page: Page, input: { minRows: number; maxBatches: number }) {
  return await page.evaluate(async ({ minRows, maxBatches, contentSelector }) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const content = document.querySelector<HTMLElement>(contentSelector)
    const scroller = content?.closest<HTMLElement>(".scroll-view__viewport")
    const root = document.querySelector<HTMLElement>("[data-session-timeline-root]")
    if (!content || !scroller || !root) throw new Error("transcript flick found no timeline scroller")
    const rowCount = () => Number(root.dataset.sessionTimelineRowCount ?? "0")
    const wheel = (deltaY: number) =>
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true }))

    const growth: number[] = []
    let batches = 0
    let stale = 0
    // 5 fruitless hops, not 1: the first page after a cold mount regularly
    // lands two or three hops late, and giving up on the first one measured a
    // two-row transcript as if it were the loaded window.
    while (batches < maxBatches && rowCount() < minRows && stale < 5) {
      const before = rowCount()
      wheel(240)
      scroller.scrollTop = Math.min(600, scroller.scrollHeight - scroller.clientHeight)
      for (let tick = 0; tick < 3; tick++) await frame()
      wheel(-240)
      scroller.scrollTop = 0
      for (let tick = 0; tick < 90 && rowCount() <= before; tick++) await frame()
      batches += 1
      growth.push(rowCount())
      stale = rowCount() > before ? 0 : stale + 1
    }
    for (let tick = 0; tick < 20; tick++) await frame()

    const heights = Array.from(content.querySelectorAll<HTMLElement>(":scope > [data-timeline-key]"))
      .map((row) => row.getBoundingClientRect().height)
      .filter((height) => height > 0)
    return {
      rows: rowCount(),
      meanRowPx: scroller.scrollHeight / Math.max(1, rowCount()),
      mountedMeanRowPx: heights.reduce((sum, height) => sum + height, 0) / Math.max(1, heights.length),
      scrollHeight: scroller.scrollHeight,
      batches,
      growth,
    } satisfies TranscriptWindow
  }, { minRows: input.minRows, maxBatches: input.maxBatches, contentSelector: TIMELINE_CONTENT })
}

export type FlickRun = {
  observedPxPerFrame: number
  travelPx: number
  /** Every sampled frame, before the flick window was taken from it. */
  sampledFrames: number
  samples: FlickFrameSample[]
}

export type FlickStart = {
  scrollTop: number
  runway: number
  anchorX: number
  anchorY: number
}

/**
 * Park the scroller where the flick will start and let the band settle.
 *
 * Separate from the measured gesture on purpose: the jump mounts a whole band
 * of rows at once, and that one-time mount is several times a frame's budget
 * at the wider bands — inside the measured window it would be reported as the
 * flick's own worst frame.
 */
export async function positionForFlick(page: Page, input: {
  pxPerFrame: number
  frames: number
  startFraction: number
}): Promise<FlickStart> {
  const travel = input.pxPerFrame * input.frames
  return await page.evaluate(async ({ travel, startFraction, contentSelector }) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const content = document.querySelector<HTMLElement>(contentSelector)
    const scroller = content?.closest<HTMLElement>(".scroll-view__viewport")
    if (!content || !scroller) throw new Error("transcript flick found no timeline scroller")
    const maxScroll = scroller.scrollHeight - scroller.clientHeight
    // Leave the flick a full viewport of runway past its travel: the last rows
    // of the list sit under `paddingEnd` and a 64px spacer, which is blank by
    // construction and would be read as a missing render band.
    const ceiling = Math.max(0, maxScroll - travel - scroller.clientHeight)
    const target = Math.min(ceiling, Math.max(0, maxScroll * startFraction))
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true }))
    scroller.scrollTop = target
    for (let tick = 0; tick < 30; tick++) await frame()
    const box = scroller.getBoundingClientRect()
    return {
      scrollTop: scroller.scrollTop,
      runway: Math.max(0, maxScroll - scroller.scrollTop - scroller.clientHeight),
      anchorX: Math.round(box.left + box.width / 2),
      anchorY: Math.round(box.top + box.height / 2),
    }
  }, { travel, startFraction: input.startFraction, contentSelector: TIMELINE_CONTENT })
}

/**
 * One fast flick down the transcript, sampled once per animation frame.
 *
 * The gesture is `Input.synthesizeScrollGesture`, not an assignment to
 * `scrollTop`: a compositor-driven scroll keeps advancing while the main
 * thread is busy, which is the condition under which an under-rendered band
 * shows through. A main-thread scroll loop stalls together with the renderer
 * and cannot expose the blank area at all.
 *
 * Each sample is taken at the top of a frame callback, so it describes the
 * frame that was just painted, and geometry is reported raw for
 * `flick-blank.ts` to analyse.
 */
export async function measureTranscriptFlick(page: Page, input: {
  pxPerFrame: number
  frames: number
  settleFrames: number
  start: FlickStart
}): Promise<FlickRun> {
  const travel = input.pxPerFrame * input.frames
  await page.evaluate(({ contentSelector }) => {
    const content = document.querySelector<HTMLElement>(contentSelector)
    const scroller = content?.closest<HTMLElement>(".scroll-view__viewport")
    if (!content || !scroller) throw new Error("transcript flick found no timeline scroller")
    const samples: FlickFrameSample[] = []
    let frame = 0
    let running = true
    const tick = () => {
      if (!running) return
      const box = scroller.getBoundingClientRect()
      samples.push({
        frame,
        at: performance.now(),
        scrollTop: scroller.scrollTop,
        viewportTop: box.top,
        viewportBottom: box.bottom,
        rows: Array.from(content.querySelectorAll<HTMLElement>(":scope > [data-timeline-key]")).map((row) => {
          const rect = row.getBoundingClientRect()
          return {
            top: rect.top,
            bottom: rect.bottom,
            painted: !!(row.textContent ?? "").trim() || !!row.querySelector("[data-timeline-row='TurnGap']"),
          }
        }),
      })
      frame += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__claxedoFlickSampler = {
      stop: () => {
        running = false
        return samples
      },
    }
  }, { contentSelector: TIMELINE_CONTENT })

  const distance = Math.min(travel, input.start.runway)
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("Input.synthesizeScrollGesture", {
      x: input.start.anchorX,
      y: input.start.anchorY,
      yDistance: -distance,
      speed: Math.round(input.pxPerFrame * 60),
      gestureSourceType: "mouse",
      preventFling: true,
    })
  } finally {
    await cdp.detach().catch(() => undefined)
  }

  const sampled = await page.evaluate(async (settleFrames) => {
    for (let tick = 0; tick < settleFrames + 2; tick++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const sampler = window.__claxedoFlickSampler
    window.__claxedoFlickSampler = undefined
    return sampler?.stop() ?? []
  }, input.settleFrames)

  const samples = flickWindow(sampled, input.settleFrames)
  return {
    observedPxPerFrame: flickObservedPxPerFrame(samples),
    travelPx: Math.round(Math.abs((samples.at(-1)?.scrollTop ?? 0) - (samples[0]?.scrollTop ?? 0))),
    sampledFrames: sampled.length,
    samples,
  }
}
