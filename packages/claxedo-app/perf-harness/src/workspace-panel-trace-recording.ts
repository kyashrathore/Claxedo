import type { BenchmarkPage as Page } from "./agent-cdp-page"
import { traceEventsFrom, type TraceEvent } from "./trace-events"
import { readNumberFields } from "./page-value"
import { READINESS_TIMEOUT_MS } from "./workspace-panel-scenario"
import {
  COUNTER_END_MARK,
  COUNTER_START_MARK,
  readMeasuredTrace,
  rendererCounters,
  type RendererTrace,
} from "./workspace-panel-trace-reading"

type Clock = {
  kind: "single-monotonic-clock"
  clock: "performance.now"
  start: number
  end: number
}

/**
 * Readiness clocks for one traced Files-panel open, filled frame by frame.
 */
type PanelOpenReadiness = {
  expectedFiles: number
  shellVisible?: number
  animationSettled?: number
  dataReady?: number
  aboveFoldPainted?: number
  lastSignature: string
  stable: number
  stableSince?: number
}

/**
 * The in-page recorder behind every traced panel measurement.
 *
 * Thirteen call sites reached it through `(window as any)`, so no reader was
 * checked against what {@link beginTrace} actually publishes, and the readiness
 * clocks below existed only in the shape of the object literal.
 */
type PublicPanelTrace = {
  active: boolean
  frames: Array<{ startedAt: number; paintedAt: number }>
  milestones: Array<{ id: string; at: number }>
  loafs: RendererTrace["longAnimationFrames"]
  /** Page clock of the first trusted pointerdown; absent until one lands. */
  trustedInputAt?: number
  lastTrustedInputAt?: number
  secondPresentedFrame: Promise<{ startedAt: number; paintedAt: number }>
  /** Present only when the caller asked for Files-open readiness. */
  openFiles?: PanelOpenReadiness
  pointer: (event: PointerEvent) => void
  stopFrames: () => void
  observer?: PerformanceObserver
}

declare global {
  interface Window {
    /** Installed by `beginTrace`, removed by `finishMeasuredTrace`/`abortTrace`. */
    __claxedoPublicPanelTrace?: PublicPanelTrace
  }
}

type TraceRecording = {
  events: TraceEvent[]
  complete: Promise<void>
  stopListening: () => void
}

export async function markActionEnd(page: Page, readyAt: number) {
  await page.evaluate(async ({ endMark, readyAt }) => {
    const trace = window.__claxedoPublicPanelTrace
    if (!trace?.active || trace.trustedInputAt === undefined) throw new Error("Claxedo measured action has no trusted input")
    const second = await trace.secondPresentedFrame
    performance.clearMarks(endMark)
    performance.mark(endMark, { startTime: Math.max(readyAt, second.paintedAt) })
  }, { endMark: COUNTER_END_MARK, readyAt })
}

export async function beginTrace(
  page: Page,
  options: { openFilesExpectedCount?: number } = {},
): Promise<TraceRecording> {
  const events: TraceEvent[] = []
  let resolveComplete = () => {}
  const complete = new Promise<void>((resolve) => { resolveComplete = resolve })
  const stopData = page.onProtocolEvent("Tracing.dataCollected", (event) => events.push(...traceEventsFrom(event)))
  const stopComplete = page.onProtocolEvent("Tracing.tracingComplete", resolveComplete)
  await page.rawCommand("Tracing.start", { categories: "devtools.timeline,blink.user_timing,toplevel", transferMode: "ReportEvents", options: "record-until-full" })
  await page.evaluate(({ startMark, endMark, openFilesExpectedCount }) => {
    if (window.__claxedoPublicPanelTrace) throw new Error("A Claxedo public renderer trace is already active")
    performance.clearMarks(endMark)
    const paintedFrames = window.__claxedoPaintedFrames
    if (!paintedFrames) throw new Error("Claxedo painted-frame clock is not installed")
    let presentedAfterInput = 0
    let presentSecond = (_frame: { startedAt: number; paintedAt: number }) => {}
    // `pointer`, `sampleOpenFiles` and `painted` are function declarations so
    // the trace object can be complete at construction: they are hoisted, and
    // their bodies only read `trace` when the browser calls them, after it is
    // assigned.
    const trace: PublicPanelTrace = {
      active: true,
      frames: [],
      milestones: [],
      loafs: [],
      secondPresentedFrame: new Promise((resolve) => { presentSecond = resolve }),
      openFiles: openFilesExpectedCount === undefined ? undefined : {
        expectedFiles: openFilesExpectedCount,
        lastSignature: "",
        stable: 0,
      },
      pointer,
      stopFrames: paintedFrames({ sample: sampleOpenFiles, painted }),
    }
    function pointer(event: PointerEvent) {
      if (!event.isTrusted) return
      const at = performance.now()
      trace.lastTrustedInputAt = at
      if (trace.trustedInputAt !== undefined) return
      performance.clearMarks(startMark)
      trace.trustedInputAt = performance.mark(startMark).startTime
      trace.milestones.push({ id: "trusted-input", at: trace.trustedInputAt })
    }
    document.addEventListener("pointerdown", trace.pointer, true)
    function sampleOpenFiles(startedAt: number) {
      if (trace.trustedInputAt === undefined || !trace.openFiles) return { startedAt }
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      const visible = (element: HTMLElement | null | undefined) => {
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }
      const navigator = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']") ?? [])
        .find((element) => visible(element))
      const rows = navigator?.querySelectorAll("[data-file-tree-path], [data-component='filetree'] button").length ?? 0
      const dataReady = !!navigator && navigator.dataset.fileTreeDataReady === "true" && rows > 0 &&
        !navigator.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
      return {
        startedAt,
        open: {
          shellVisible: visible(shell),
          shellSettled: shell?.dataset.shellSettled === "true",
          dataReady,
          signature: dataReady ? JSON.stringify([shell?.dataset.stateWorkspaceDir, rows, navigator?.innerText.length, trace.openFiles.expectedFiles]) : "",
        },
      }
    }
    function painted(frame: ReturnType<typeof sampleOpenFiles>, paintedAt: number) {
      if (!trace.active) return true
      if (trace.frames.length < 600) trace.frames.push({ startedAt: frame.startedAt, paintedAt })
      if (trace.trustedInputAt !== undefined && frame.startedAt >= trace.trustedInputAt && ++presentedAfterInput === 2) {
        presentSecond({ startedAt: frame.startedAt, paintedAt })
      }
      const openFiles = trace.openFiles
      if (!frame.open || !openFiles) return
      if (frame.open.shellVisible && openFiles.shellVisible === undefined) openFiles.shellVisible = paintedAt
      if (openFiles.shellVisible !== undefined && frame.open.shellSettled && openFiles.animationSettled === undefined) {
        openFiles.animationSettled = paintedAt
      }
      if (frame.open.dataReady && openFiles.dataReady === undefined) openFiles.dataReady = paintedAt
      openFiles.stable = frame.open.dataReady && openFiles.shellVisible !== undefined && frame.open.signature === openFiles.lastSignature
        ? openFiles.stable + 1
        : frame.open.dataReady ? 1 : 0
      if (openFiles.stable === 1) openFiles.stableSince = paintedAt
      openFiles.lastSignature = frame.open.signature
      if (openFiles.stable >= 2 && openFiles.aboveFoldPainted === undefined) openFiles.aboveFoldPainted = openFiles.stableSince
    }
    if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      trace.observer = new PerformanceObserver((list: PerformanceObserverEntryList) => {
        for (const raw of list.getEntries()) {
          if (trace.loafs.length >= 100) break
          trace.loafs.push({
            start: raw.startTime, duration: raw.duration, blockingDuration: raw.blockingDuration ?? 0,
            renderStart: raw.renderStart ?? raw.startTime, styleAndLayoutStart: raw.styleAndLayoutStart ?? raw.startTime,
            scripts: (raw.scripts ?? []).slice(0, 32).map((script) => ({
              sourceURL: (() => { const value = script.sourceURL ?? ""; try { return new URL(value).pathname.split("/").slice(-3).join("/").slice(0, 500) } catch { return value.split("/").slice(-3).join("/").slice(0, 500) } })(),
              functionName: (script.sourceFunctionName ?? "").slice(0, 300), invokerType: (script.invokerType ?? script.invoker ?? "").slice(0, 120),
              duration: script.duration, forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration ?? 0,
            })),
          })
        }
      })
      trace.observer.observe({ type: "long-animation-frame", buffered: false } as PerformanceObserverInit)
    }
    window.__claxedoPublicPanelTrace = trace
  }, { startMark: COUNTER_START_MARK, endMark: COUNTER_END_MARK, openFilesExpectedCount: options.openFilesExpectedCount })
  return { events, complete, stopListening: () => { stopData(); stopComplete() } }
}

export async function waitForTracedOpenFiles(page: Page) {
  return readNumberFields(await page.evaluate(async () => {
    const deadline = performance.now() + 30_000
    return new Promise<{ shellVisible: number; animationSettled: number; dataReady: number; aboveFoldPainted: number }>((resolve, reject) => {
      const frame = () => {
        const trace = window.__claxedoPublicPanelTrace
        const readiness = trace?.openFiles
        if (!trace?.active || !readiness) return reject(new Error("Claxedo panel-open readiness observer was not armed before input"))
        const { shellVisible, animationSettled, dataReady, aboveFoldPainted } = readiness
        if (
          Number.isFinite(shellVisible) && shellVisible !== undefined &&
          Number.isFinite(animationSettled) && animationSettled !== undefined &&
          Number.isFinite(dataReady) && dataReady !== undefined &&
          Number.isFinite(aboveFoldPainted) && aboveFoldPainted !== undefined
        ) {
          return resolve({ shellVisible, animationSettled, dataReady, aboveFoldPainted })
        }
        if (performance.now() >= deadline) {
          return reject(new Error(`Claxedo prearmed panel-open observer did not reach readiness: ${JSON.stringify(readiness)}`))
        }
        requestAnimationFrame(frame)
      }
      frame()
    })
  }), ["shellVisible", "animationSettled", "dataReady", "aboveFoldPainted"])
}

export async function addMilestones(page: Page, milestones: Array<{ id: string; at: number }>) {
  await page.evaluate((items) => {
    const trace = window.__claxedoPublicPanelTrace
    if (!trace?.active) throw new Error("No active Claxedo public renderer trace")
    trace.milestones.push(...items)
  }, milestones)
}

export async function finishMeasuredTrace(page: Page, recording: TraceRecording) {
  const trace = readMeasuredTrace(await page.evaluate(({ endMark }) => {
    const current = window.__claxedoPublicPanelTrace
    const startedAt = current?.trustedInputAt
    if (!current?.active || startedAt === undefined || !Number.isFinite(startedAt)) {
      throw new Error("Claxedo measured action has no trusted input")
    }
    const end = performance.getEntriesByName(endMark, "mark").at(-1)?.startTime
    if (end === undefined) throw new Error("Claxedo measured action has no end mark")
    current.milestones.push({ id: "interactive", at: end }, { id: "complete", at: end })
    current.active = false
    current.stopFrames()
    document.removeEventListener("pointerdown", current.pointer, true)
    current.observer?.disconnect()
    delete window.__claxedoPublicPanelTrace
    return {
      clock: "performance.now" as const,
      transitionMode: "animated" as const,
      milestones: current.milestones.toSorted((left, right) => left.at - right.at),
      frameTimestampsMs: current.frames.filter((frame) => frame.startedAt >= startedAt && frame.paintedAt <= end).map((frame) => frame.paintedAt),
      longAnimationFrames: current.loafs.filter((entry) => entry.start >= startedAt && entry.start + entry.duration <= end + 0.5),
      counterInterval: { start: startedAt, end },
    }
  }, { endMark: COUNTER_END_MARK }))
  await page.rawCommand("Tracing.end")
  await Promise.race([recording.complete, new Promise((_, reject) => setTimeout(() => reject(new Error("Claxedo renderer trace did not finish")), READINESS_TIMEOUT_MS))])
  recording.stopListening()
  const rendererTrace: RendererTrace = { ...trace, counters: rendererCounters(recording.events) }
  const clock: Clock = { kind: "single-monotonic-clock", clock: "performance.now", start: trace.counterInterval.start, end: trace.counterInterval.end }
  return { clock, rendererTrace }
}

export async function abortTrace(page: Page, recording: TraceRecording) {
  await page.evaluate(() => {
    const trace = window.__claxedoPublicPanelTrace
    if (trace) {
      trace.active = false
      trace.stopFrames()
      document.removeEventListener("pointerdown", trace.pointer, true)
      trace.observer?.disconnect()
      delete window.__claxedoPublicPanelTrace
    }
  }).catch(() => undefined)
  await page.rawCommand("Tracing.end").catch(() => undefined)
  await recording.complete.catch(() => undefined)
  recording.stopListening()
}
