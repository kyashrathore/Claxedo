import type { CDPSession, Page } from "playwright-core"

// Renderer-production targets. Missing these windows makes the target refresh
// rate impossible, although passing them does not prove compositor presentation.
export const FRAME_120HZ_MS = 1000 / 120 // 8.333ms — the 120hz goal
export const FRAME_60HZ_MS = 1000 / 60 // 16.667ms — the hard floor

// A claim that a flow stays at or above 60hz cannot discard its first one or
// two slow frames. Keep the allowance explicit and strict.
export const FRAMES_OVER_60HZ_ALLOWANCE = 0

export type FrameVerdict = "green" | "amber" | "red"

export type FrameCausalMetric = {
  dom: {
    nodesBefore: number
    nodesAfter: number
    composedNodesBefore: number
    composedNodesAfter: number
    nodesAdded: number
    nodesRemoved: number
    attributesChanged: number
  }
  longAnimationFrames: Array<{
    startTime: number
    duration: number
    blockingDuration: number
    renderStart: number
    styleAndLayoutStart: number
    scripts: Array<{
      duration: number
      forcedStyleAndLayoutDuration: number
      invoker: string
      invokerType: string
      sourceURL: string
      sourceFunctionName: string
      sourceCharPosition: number
    }>
  }>
  longTasks: Array<{ name: string; startTime: number; duration: number }>
  events: Array<{ name: string; startTime: number; duration: number; interactionId: number }>
  resources: Array<{
    name: string
    startTime: number
    initiatorType: string
    duration: number
    transferSize: number
    decodedBodySize: number
  }>
  performance?: Record<string, number>
  performanceSource?: "cdp-cumulative-delta" | "trusted-window-trace"
  performanceUnavailableReason?: string
  cpuProfile?: Array<{
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
    selfTimeMs: number
    samples: number
  }>
  traceTasks?: Array<{
    durationMs: number
    events: Array<{
      name: string
      durationMs: number
      detail?: string
    }>
  }>
  rendererPhases?: Array<{ name: string; durationMs: number }>
}

export type DomMutationSnapshot = Pick<
  FrameCausalMetric["dom"],
  "attributesChanged" | "nodesAdded" | "nodesRemoved"
>

type TimedDuration = {
  startTime: number
  duration: number
}

// One measured interaction. These are renderer scheduling intervals, not
// presented-display frames. `p95FrameMs` describes the observed interval
// population; `worstFrameMs` and `framesOver1667` enforce the strict 60hz
// renderer-deadline floor.
export type FrameMetric = {
  label: string
  worstFrameMs: number
  p95FrameMs: number
  framesOver833: number
  framesOver1667: number
  sampleCount: number
  completionMs: number
  verdict: FrameVerdict
  observedFrameIntervalsMs?: number[]
  mainThreadTasksMs?: number[]
  frameIntervalsMs?: number[]
  longAnimationFrameMs?: number[]
  unattributedSchedulingGapsMs?: number[]
  rendererScheduling?: Array<{
    rafIntervalMs: number
    maxOverlappingEventLoopIntervalMs: number
  }>
  runs?: FrameRunMetric[]
  causal?: FrameCausalMetric
}

export type FrameRunMetric = Omit<FrameMetric, "runs" | "causal">

export function frameVerdict(p95FrameMs: number): FrameVerdict {
  if (p95FrameMs <= FRAME_120HZ_MS + 0.5) return "green"
  if (p95FrameMs <= FRAME_60HZ_MS + 0.5) return "amber"
  return "red"
}

// The badge reflects the full picture: the interval distribution (p95) AND
// whether any individual renderer interval missed the 60hz deadline.
function verdictFor(p95FrameMs: number, framesOver1667: number, worstFrameMs: number): FrameVerdict {
  if (
    p95FrameMs > FRAME_60HZ_MS + 0.5
    || worstFrameMs > FRAME_60HZ_MS
    || framesOver1667 > FRAMES_OVER_60HZ_ALLOWANCE
  ) return "red"
  if (p95FrameMs > FRAME_120HZ_MS + 0.5 || worstFrameMs > FRAME_120HZ_MS) return "amber"
  return "green"
}

export function verdictLabel(verdict: FrameVerdict) {
  if (verdict === "green") return "120hz-capable"
  if (verdict === "amber") return "60hz-capable"
  return "missed-60hz"
}

// Launch Chromium with vsync and the frame-rate cap disabled so requestAnimationFrame
// fires as fast as the renderer allows. This is a repeatable main-thread production
// proxy. It does not observe the packaged Electron compositor, GPU presentation, or
// a physical display and therefore cannot by itself prove presented 60/120hz output.
export const frameSamplingLaunchArgs = [
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
]

export async function startRecorder(
  page: Page,
  recorderOptions = {
    // Per-switch mode publishes DOM deltas for each click, so it owns the
    // causal recorder even when the broader diagnostic report is disabled.
    captureCausal: process.env.CLAXEDO_PERF_CAUSAL === "1" || process.env.CLAXEDO_PERF_PER_SWITCH === "1",
    // Headless Chromium can emit 17.8ms rAF intervals on about:blank even when
    // the main thread is continuously available. Keep the low-overhead heartbeat
    // active in every run so scheduler cadence is never blamed on application JS.
    captureHeartbeat: true,
    captureTrace: process.env.CLAXEDO_PERF_TRACE === "1",
  },
) {
  await page.evaluate(({ captureCausal, captureHeartbeat, captureTrace }: { captureCausal: boolean; captureHeartbeat: boolean; captureTrace: boolean }) => {
    const w = window as unknown as Record<string, unknown>
    w.__claxedoPerfTrace = captureTrace
    w.__claxedoPerfRendererPhases = []
    const existing = w.__perfFrames as { stop?: () => void } | undefined
    existing?.stop?.()
    const frames: TimedDuration[] = []
    const loaf: TimedDuration[] = []
    const longAnimationFrames: FrameCausalMetric["longAnimationFrames"] = []
    const longTasks: FrameCausalMetric["longTasks"] = []
    const events: FrameCausalMetric["events"] = []
    const resources: FrameCausalMetric["resources"] = []
    const eventLoop: TimedDuration[] = []
    const mutationBatches: Array<DomMutationSnapshot & { at: number }> = []
    const composedNodeCount = () => {
      const count = (root: Document | ShadowRoot): number => {
        const elements = [...root.querySelectorAll("*")]
        return elements.length + elements.reduce((total, element) => total + (element.shadowRoot ? count(element.shadowRoot) : 0), 0)
      }
      return count(document)
    }
    const dom = {
      nodesBefore: captureCausal ? document.getElementsByTagName("*").length : 0,
      nodesAfter: 0,
      composedNodesBefore: captureCausal ? composedNodeCount() : 0,
      composedNodesAfter: 0,
      nodesAdded: 0,
      nodesRemoved: 0,
      attributesChanged: 0,
    }
    const startedAt = performance.now()
    // This boundary is mutable because recorder installation necessarily
    // precedes Playwright delivering the real input. A trusted pointerdown can
    // move it to the browser's own event timestamp, before application capture
    // handlers run, without including transport/setup time in the sample.
    let armedAt = startedAt
    let last = performance.now()
    let running = true
    let rafId = 0
    let eventLoopLast = performance.now()
    const eventLoopId = captureHeartbeat
      ? window.setInterval(() => {
          const now = performance.now()
          eventLoop.push({ startTime: eventLoopLast, duration: now - eventLoopLast })
          eventLoopLast = now
        }, 8)
      : undefined
    const tick = (t: number) => {
      if (!running) return
      frames.push({ startTime: last, duration: t - last })
      last = t
      rafId = requestAnimationFrame(tick)
    }
    last = performance.now()
    rafId = requestAnimationFrame(tick)
    const observers: PerformanceObserver[] = []
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < armedAt) continue
          loaf.push({ startTime: entry.startTime, duration: entry.duration })
          if (!captureCausal) continue
          const frame = entry as PerformanceEntry & {
            blockingDuration?: number
            renderStart?: number
            styleAndLayoutStart?: number
            scripts?: Array<{
              duration?: number
              forcedStyleAndLayoutDuration?: number
              invoker?: string
              invokerType?: string
              sourceURL?: string
              sourceFunctionName?: string
              sourceCharPosition?: number
            }>
          }
          longAnimationFrames.push({
            startTime: frame.startTime,
            duration: frame.duration,
            blockingDuration: frame.blockingDuration ?? 0,
            renderStart: frame.renderStart ?? 0,
            styleAndLayoutStart: frame.styleAndLayoutStart ?? 0,
            scripts: (frame.scripts ?? []).map((script) => ({
              duration: script.duration ?? 0,
              forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration ?? 0,
              invoker: script.invoker ?? "",
              invokerType: script.invokerType ?? "",
              sourceURL: script.sourceURL ?? "",
              sourceFunctionName: script.sourceFunctionName ?? "",
              sourceCharPosition: script.sourceCharPosition ?? 0,
            })),
          })
        }
      })
      // long-animation-frame captures main-thread blocking >=50ms with attribution.
      observer.observe({ type: "long-animation-frame", buffered: true } as PerformanceObserverInit)
      observers.push(observer)
    } catch {}
    const observe = (type: string, read: (entry: PerformanceEntry) => void) => {
      if (!captureCausal) return
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // Observers may deliver buffered/pending setup entries after the
            // recorder has been armed. Entry time, not callback delivery time,
            // decides whether an entry belongs to the interaction.
            if (entry.startTime >= armedAt) read(entry)
          }
        })
        observer.observe({ type, buffered: false } as PerformanceObserverInit)
        observers.push(observer)
      } catch {}
    }
    observe("longtask", (entry) => longTasks.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration }))
    observe("event", (entry) => {
      const event = entry as PerformanceEntry & { interactionId?: number }
      events.push({ name: event.name, startTime: event.startTime, duration: event.duration, interactionId: event.interactionId ?? 0 })
    })
    observe("resource", (entry) => {
      const resource = entry as PerformanceResourceTiming
      resources.push({
        name: resource.name,
        startTime: resource.startTime,
        initiatorType: resource.initiatorType,
        duration: resource.duration,
        transferSize: resource.transferSize,
        decodedBodySize: resource.decodedBodySize,
      })
    })
    const mutations = captureCausal
      ? new MutationObserver((records) => {
          const batch = { at: performance.now(), nodesAdded: 0, nodesRemoved: 0, attributesChanged: 0 }
          for (const record of records) {
            batch.nodesAdded += record.addedNodes.length
            batch.nodesRemoved += record.removedNodes.length
            if (record.type === "attributes") batch.attributesChanged++
          }
          mutationBatches.push(batch)
          dom.nodesAdded += batch.nodesAdded
          dom.nodesRemoved += batch.nodesRemoved
          dom.attributesChanged += batch.attributesChanged
        })
      : undefined
    mutations?.observe(document, { attributes: true, childList: true, subtree: true })
    const causal: FrameCausalMetric | undefined = captureCausal ? { dom, longAnimationFrames, longTasks, events, resources } : undefined
    let trustedPointerdownAt: number | undefined
    let trustedPointerdownListener: ((event: PointerEvent) => void) | undefined
    const clearTrustedPointerdownListener = () => {
      if (!trustedPointerdownListener) return
      window.removeEventListener("pointerdown", trustedPointerdownListener, true)
      trustedPointerdownListener = undefined
    }
    const arm = (at = performance.now(), dropPendingMutations = true) => {
      armedAt = at
      frames.length = 0
      loaf.length = 0
      eventLoop.length = 0
      longAnimationFrames.length = 0
      longTasks.length = 0
      events.length = 0
      resources.length = 0
      mutationBatches.length = 0
      // Drop pending setup mutations before changing the baseline. Otherwise
      // their callback can run after pointerdown and charge them to the click.
      if (dropPendingMutations) mutations?.takeRecords()
      dom.nodesBefore = captureCausal ? document.getElementsByTagName("*").length : 0
      dom.nodesAfter = 0
      dom.composedNodesBefore = captureCausal ? composedNodeCount() : 0
      dom.composedNodesAfter = 0
      dom.nodesAdded = 0
      dom.nodesRemoved = 0
      dom.attributesChanged = 0
      w.__claxedoPerfRendererPhases = []
      last = at
      eventLoopLast = at
      return at
    }
    w.__perfFrames = {
      frames,
      loaf,
      eventLoop,
      causal,
      arm,
      armOnNextTrustedPointerdown(mark: string) {
        clearTrustedPointerdownListener()
        trustedPointerdownAt = undefined
        performance.clearMarks(mark)
        // Clear setup mutations while arming, before the input exists. Do not
        // clear again inside the event listener: an earlier window capture
        // handler may already have made a click-caused DOM change in this same
        // dispatch, and that mutation belongs to the measured interaction.
        mutations?.takeRecords()
        trustedPointerdownListener = (event) => {
          if (!event.isTrusted) return
          clearTrustedPointerdownListener()
          // Event.timeStamp and PerformanceEntry.startTime share the page's
          // monotonic time origin. Using it also includes capture listeners that
          // run after this window-level listener in the measured interval.
          trustedPointerdownAt = arm(event.timeStamp, false)
          performance.mark(mark, { startTime: event.timeStamp })
        }
        window.addEventListener("pointerdown", trustedPointerdownListener, true)
      },
      trustedPointerdownAt() {
        return trustedPointerdownAt
      },
      cancelTrustedPointerdownArm() {
        clearTrustedPointerdownListener()
      },
      stop(completionMs?: number) {
        clearTrustedPointerdownListener()
        const endedAt = completionMs === undefined || trustedPointerdownAt === undefined ? undefined : trustedPointerdownAt + completionMs
        if (endedAt !== undefined) {
          const retain = <T extends { startTime: number }>(entries: T[]) => {
            const retained = entries
              .filter((entry) => entry.startTime < endedAt)
              .map((entry) => "duration" in entry && typeof entry.duration === "number"
                ? { ...entry, duration: Math.min(entry.duration, endedAt - entry.startTime) }
                : entry) as T[]
            entries.splice(0, entries.length, ...retained)
          }
          retain(frames)
          retain(loaf)
          retain(eventLoop)
          retain(longAnimationFrames)
          retain(longTasks)
          retain(events)
          retain(resources)
          const retainedMutations = mutationBatches.filter((batch) => batch.at <= endedAt)
          dom.nodesAdded = retainedMutations.reduce((total, batch) => total + batch.nodesAdded, 0)
          dom.nodesRemoved = retainedMutations.reduce((total, batch) => total + batch.nodesRemoved, 0)
          dom.attributesChanged = retainedMutations.reduce((total, batch) => total + batch.attributesChanged, 0)
        }
        running = false
        cancelAnimationFrame(rafId)
        if (eventLoopId !== undefined) clearInterval(eventLoopId)
        observers.forEach((observer) => observer.disconnect())
        mutations?.disconnect()
        dom.nodesAfter = captureCausal ? document.getElementsByTagName("*").length : 0
        dom.composedNodesAfter = captureCausal ? composedNodeCount() : 0
        if (causal && completionMs === undefined) {
          causal.rendererPhases = (w.__claxedoPerfRendererPhases as FrameCausalMetric["rendererPhases"] | undefined) ?? []
        }
        delete w.__claxedoPerfTrace
        delete w.__claxedoPerfRendererPhases
      },
    }
  }, recorderOptions)
}

export async function readDomMutationSnapshot(page: Page): Promise<DomMutationSnapshot | undefined> {
  return await page.evaluate(() => {
    const recorder = (window as unknown as Record<string, unknown>).__perfFrames as
      | {
          causal?: { dom?: DomMutationSnapshot }
        }
      | undefined
    const dom = recorder?.causal?.dom
    if (!dom) return
    return {
      attributesChanged: dom.attributesChanged,
      nodesAdded: dom.nodesAdded,
      nodesRemoved: dom.nodesRemoved,
    }
  })
}

async function stopRecorder(page: Page, completionMs?: number) {
  return await page
    .evaluate((completionMs) => {
      const w = window as unknown as Record<string, unknown>
      const rec = w.__perfFrames as {
        frames: TimedDuration[]
        loaf: TimedDuration[]
        eventLoop: TimedDuration[]
        causal?: FrameCausalMetric
        stop: (completionMs?: number) => void
      } | undefined
      if (!rec) return { frames: [] as TimedDuration[], loaf: [] as TimedDuration[], eventLoop: [] as TimedDuration[], causal: undefined }
      rec.stop(completionMs)
      return { frames: rec.frames, loaf: rec.loaf, eventLoop: rec.eventLoop, causal: rec.causal }
    }, completionMs)
    .catch(() => ({ frames: [] as TimedDuration[], loaf: [] as TimedDuration[], eventLoop: [] as TimedDuration[], causal: undefined }))
}

export type InteractionMeasurementOptions = {
  /**
   * Install a capture listener before `action` and reset the recorder at the
   * first trusted pointerdown. In this mode `action` must return the interaction
   * completion duration measured from that pointerdown in page time.
   */
  armAt?: "action" | "trusted-pointerdown"
}

export type InteractionActionResult = void | number | { completionMs: number }

function pageCompletionMs(result: InteractionActionResult) {
  const duration = typeof result === "number" ? result : result?.completionMs
  return duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

// Record every frame produced while `action` runs, then summarize. The action is
// the real user interaction (a click, a toggle, a drag) driven through Playwright.
// Existing callers retain action-boundary timing. Timing-sensitive flows opt in
// to a trusted page-clock boundary and return their page-clock completion.
export async function measureInteraction(
  page: Page,
  label: string,
  action: () => Promise<InteractionActionResult>,
  options: InteractionMeasurementOptions = {},
): Promise<FrameMetric> {
  await startRecorder(page)
  const trustedTraceMark = options.armAt === "trusted-pointerdown"
    ? `claxedo-perf-trusted-${crypto.randomUUID()}`
    : undefined
  const cpuProfileEnabled = process.env.CLAXEDO_PERF_CPU_PROFILE === "1"
  const traceDetailsEnabled = process.env.CLAXEDO_PERF_TRACE === "1"
  const cdp = await page.context().newCDPSession(page)
  const traceEvents: TraceEvent[] = []
  await cdp.send("Performance.enable")
  cdp.on("Tracing.dataCollected", (event) => {
    traceEvents.push(...event.value as unknown as TraceEvent[])
  })
  // Blink's invalidation tracking emits one instant event per invalidated
  // element, which is heavy enough to distort the very timings it explains —
  // hence its own opt-in, and hence attribution-only: never gating evidence.
  const styleDumpPath = process.env.CLAXEDO_PERF_STYLE_DUMP
  const traceCategories = styleDumpPath
      ? "__metadata,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking"
      : traceDetailsEnabled
      ? "__metadata,devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink.user_timing"
      : "__metadata,devtools.timeline,disabled-by-default-devtools.timeline"
  await cdp.send("Tracing.start", {
    categories: trustedTraceMark && !traceCategories.includes("blink.user_timing")
      ? `${traceCategories},blink.user_timing`
      : traceCategories,
    transferMode: "ReportEvents",
  })
  if (cpuProfileEnabled) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.start")
  }
  const performanceBefore = await readPerformanceMetrics(cdp)
  // Clear setup intervals immediately before the action, or arrange for the
  // browser to clear them at the exact trusted pointerdown boundary. The latter
  // excludes Playwright transport/delivery overhead from both completion time
  // and the renderer/causal samples.
  await page.evaluate(({ armAt, trustedTraceMark }) => {
    const rec = (window as unknown as Record<string, unknown>).__perfFrames as {
      arm?: () => void
      armOnNextTrustedPointerdown?: (mark: string) => void
    } | undefined
    if (armAt === "trusted-pointerdown" && trustedTraceMark) rec?.armOnNextTrustedPointerdown?.(trustedTraceMark)
    else rec?.arm?.()
  }, { armAt: options.armAt ?? "action", trustedTraceMark })
  const started = performance.now()
  const actionResult = await action()
  const actionBoundaryCompletionMs = performance.now() - started
  const returnedCompletionMs = pageCompletionMs(actionResult)
  let completionMs = actionBoundaryCompletionMs
  if (options.armAt === "trusted-pointerdown") {
    const trustedPointerdownAt = await page.evaluate(() => {
      const rec = (window as unknown as Record<string, unknown>).__perfFrames as {
        trustedPointerdownAt?: () => number | undefined
        cancelTrustedPointerdownArm?: () => void
      } | undefined
      const at = rec?.trustedPointerdownAt?.()
      rec?.cancelTrustedPointerdownArm?.()
      return at
    })
    if (trustedPointerdownAt === undefined) {
      throw new Error(`${label} did not emit a trusted pointerdown after the recorder was armed`)
    }
    if (returnedCompletionMs === undefined) {
      throw new Error(`${label} must return a finite page-clock completionMs when armed at trusted pointerdown`)
    }
    completionMs = returnedCompletionMs
  }
  // Legacy action-boundary callers rely on two flush frames. A trusted action
  // returns the stable-paint duration from the page and is sealed at that exact
  // page-clock deadline instead of extending into Playwright delivery time.
  if (options.armAt !== "trusted-pointerdown") {
    await page
      .evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      .catch(() => undefined)
  }
  const { frames, loaf, eventLoop, causal } = await stopRecorder(
    page,
    options.armAt === "trusted-pointerdown" ? completionMs : undefined,
  )
  const performanceAfter = await readPerformanceMetrics(cdp)
  const profile = cpuProfileEnabled
    ? await cdp.send("Profiler.stop") as {
        profile: {
          nodes: Array<{
            id: number
            callFrame: {
              functionName: string
              url: string
              lineNumber: number
              columnNumber: number
            }
          }>
          samples?: number[]
          timeDeltas?: number[]
        }
      }
    : undefined
  const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
  await cdp.send("Tracing.end")
  await complete
  await cdp.detach()
  const measuredTraceEvents = trustedTraceMark
    ? traceEventsInTrustedWindow(traceEvents, trustedTraceMark, completionMs)
    : traceEvents
  if (trustedTraceMark) await page.evaluate((mark) => performance.clearMarks(mark), trustedTraceMark).catch(() => undefined)
  // Style/layout invalidation attribution. `recalcStyleMs` says style recalc is
  // expensive; only these events say WHICH element and WHICH selector feature
  // caused it. `ScheduleStyleInvalidationTracking` names the node and the
  // changed attribute / class / pseudo (`changedPseudo: "has"` for a `:has()`
  // anchor re-check) and carries the scheduling JS stack;
  // `StyleInvalidatorInvalidationTracking` names every element the resulting
  // invalidation set then swept, with the selector part that matched. Joining
  // them on `invalidationSet` turns "style is slow" into "this attribute write
  // on this element dirtied these N elements through this selector".
  if (styleDumpPath) {
    const wanted = new Set([
      "UpdateLayoutTree",
      "ScheduleStyleInvalidationTracking",
      "StyleRecalcInvalidationTracking",
      "StyleInvalidatorInvalidationTracking",
      "LayoutInvalidationTracking",
      "InvalidateLayout",
    ])
    const rows = (measuredTraceEvents as unknown as Array<Record<string, unknown>>)
      .filter((event) => wanted.has(event.name as string))
    await Bun.write(`${styleDumpPath}.${label}.jsonl`, rows.map((row) => JSON.stringify(row)).join("\n"))
  }
  // CDP Performance.getMetrics and the CPU sampler are aggregate counters and
  // cannot be reset synchronously by a page capture listener. Publishing their
  // pre-pointer delivery gap as trusted-window data would be false precision;
  // the cropped trace below remains the exact attribution source in this mode.
  if (causal && !trustedTraceMark) {
    causal.performance = performanceMetricDelta(performanceBefore, performanceAfter)
    causal.performanceSource = "cdp-cumulative-delta"
  }
  if (causal && trustedTraceMark) {
    const measurement = trustedWindowRendererPerformance(measuredTraceEvents)
    if (measurement.state === "measured") {
      causal.performance = measurement.performance
      causal.performanceSource = "trusted-window-trace"
    } else {
      causal.performanceUnavailableReason = measurement.reason
    }
  }
  if (causal && profile && !trustedTraceMark) causal.cpuProfile = summarizeCpuProfile(profile.profile)
  // Opt-in raw-profile persistence for offline flamegraph analysis. The
  // summarized attribution above is dropped for trusted-mark interactions, so
  // this is the only way to see WHERE script time goes in those windows;
  // resolve the frames against the build's sourcemaps.
  if (profile && process.env.CLAXEDO_PERF_PROFILE_DIR) {
    const dir = process.env.CLAXEDO_PERF_PROFILE_DIR
    const file = `${dir}/${label.replaceAll(/[^a-z0-9-]/gi, "_")}-${Date.now()}.cpuprofile`
    await Bun.write(file, JSON.stringify(profile.profile))
  }
  if (causal && measuredTraceEvents.length > 0) causal.traceTasks = summarizeTraceTasks(measuredTraceEvents)
  return buildFrameMetric(
    label,
    frames,
    loaf,
    completionMs,
    causal,
    eventLoop,
    rendererRunTasks(measuredTraceEvents).map((task) => task.dur! / 1_000),
  )
}

export type TraceEvent = {
  name: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: {
    name?: string
    data?: {
      functionName?: string
      scriptName?: string
      url?: string
      lineNumber?: number
      columnNumber?: number
    }
  }
}

export type TrustedWindowRendererPerformance = {
  scriptMs: number
  scriptCount: number
  recalcStyleMs: number
  recalcStyleCount: number
  layoutMs: number
  layoutCount: number
  taskMs: number
  taskCount: number
}

export type TrustedWindowRendererPerformanceResult =
  | { state: "measured"; performance: TrustedWindowRendererPerformance }
  | { state: "unavailable"; reason: string }

export function traceEventsInTrustedWindow(events: TraceEvent[], mark: string, completionMs: number) {
  const marker = events.find((event) => event.name === mark || event.args?.name === mark || event.args?.data?.functionName === mark)
  if (!marker) throw new Error(`Trusted interaction trace mark was not collected: ${mark}`)
  const startedAt = marker.ts
  const endedAt = startedAt + completionMs * 1_000
  return events.flatMap((event): TraceEvent[] => {
    // Thread metadata is emitted before the interaction but is required to
    // identify CrRendererMain when interpreting the cropped RunTask records.
    if (event.name === "thread_name" || event.name === "process_name") return [event]
    const eventEnd = event.ts + (event.dur ?? 0)
    if (event.dur === undefined) return event.ts >= startedAt && event.ts <= endedAt ? [event] : []
    const overlapStart = Math.max(event.ts, startedAt)
    const overlapEnd = Math.min(eventEnd, endedAt)
    if (overlapEnd <= overlapStart) return []
    return [{ ...event, ts: overlapStart, dur: overlapEnd - overlapStart }]
  })
}

type TraceInterval = { start: number; end: number }

const SCRIPT_TRACE_EVENT_NAMES = new Set([
  "EvaluateModule",
  "EvaluateScript",
  "EventDispatch",
  "FireAnimationFrame",
  "FunctionCall",
  "RunMicrotasks",
  "TimerFire",
  "V8.Execute",
  "v8.run",
])

const STYLE_RECALC_TRACE_EVENT_NAMES = new Set([
  "RecalculateStyle",
  "RecalculateStyles",
  "UpdateLayoutTree",
])

function declaredRendererThreadKeys(events: TraceEvent[]) {
  return new Set(
    events
      .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")
      .map((event) => `${event.pid}:${event.tid}`),
  )
}

function rendererThreadKeys(events: TraceEvent[]) {
  const rendererThreads = declaredRendererThreadKeys(events)
  const runTasks = events
    .filter((event) => event.ph === "X" && event.dur && event.name.includes("RunTask"))
  const fallbackThread = runTasks
    .reduce((totals, event) => {
      const key = `${event.pid}:${event.tid}`
      totals.set(key, (totals.get(key) ?? 0) + event.dur!)
      return totals
    }, new Map<string, number>())
    .entries()
    .toArray()
    .toSorted((left, right) => right[1] - left[1])[0]?.[0]
  return rendererThreads.size > 0 ? rendererThreads : new Set(fallbackThread ? [fallbackThread] : [])
}

function rendererRunTasks(events: TraceEvent[]) {
  const threads = rendererThreadKeys(events)
  return events.filter((event) =>
    event.ph === "X" && event.dur && event.name.includes("RunTask") && threads.has(`${event.pid}:${event.tid}`))
}

function intervalsFor(
  events: TraceEvent[],
  threads: Set<string>,
  matches: (event: TraceEvent) => boolean,
) {
  return events.flatMap((event): TraceInterval[] =>
    event.ph === "X" && event.dur && event.dur > 0 && threads.has(`${event.pid}:${event.tid}`) && matches(event)
      ? [{ start: event.ts, end: event.ts + event.dur }]
      : [])
}

function unionIntervals(intervals: TraceInterval[]) {
  const sorted = intervals.toSorted((left, right) => left.start - right.start || left.end - right.end)
  const result: TraceInterval[] = []
  for (const interval of sorted) {
    const previous = result.at(-1)
    if (!previous || interval.start > previous.end) {
      result.push({ ...interval })
      continue
    }
    previous.end = Math.max(previous.end, interval.end)
  }
  return result
}

function intersectIntervals(left: TraceInterval[], right: TraceInterval[]) {
  const intersections: TraceInterval[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!
    const b = right[rightIndex]!
    const start = Math.max(a.start, b.start)
    const end = Math.min(a.end, b.end)
    if (end > start) intersections.push({ start, end })
    if (a.end <= b.end) leftIndex++
    else rightIndex++
  }
  return unionIntervals(intersections)
}

function subtractIntervals(base: TraceInterval[], excluded: TraceInterval[]) {
  if (excluded.length === 0) return base
  return base.flatMap((interval): TraceInterval[] => {
    const remaining: TraceInterval[] = []
    let cursor = interval.start
    for (const blocked of excluded) {
      if (blocked.end <= cursor) continue
      if (blocked.start >= interval.end) break
      if (blocked.start > cursor) remaining.push({ start: cursor, end: Math.min(blocked.start, interval.end) })
      cursor = Math.max(cursor, blocked.end)
      if (cursor >= interval.end) break
    }
    if (cursor < interval.end) remaining.push({ start: cursor, end: interval.end })
    return remaining
  })
}

function intervalMetric(intervals: TraceInterval[]) {
  return {
    ms: round(intervals.reduce((total, interval) => total + interval.end - interval.start, 0) / 1_000),
    count: intervals.length,
  }
}

/**
 * Derive renderer work from an already-cropped trusted interaction trace.
 * Durations are unions on CrRendererMain and phase buckets are exclusive:
 * layout owns overlaps with style, and both own overlaps with script. Counts
 * describe the resulting disjoint work regions, not nested trace records.
 */
export function trustedWindowRendererPerformance(events: TraceEvent[]): TrustedWindowRendererPerformanceResult {
  const threads = declaredRendererThreadKeys(events)
  if (threads.size === 0) return { state: "unavailable", reason: "trusted trace had no CrRendererMain thread" }
  const taskIntervals = unionIntervals(intervalsFor(events, threads, (event) => event.name.includes("RunTask")))
  if (taskIntervals.length === 0) return { state: "unavailable", reason: "trusted trace had no CrRendererMain RunTask" }

  const layout = intersectIntervals(
    unionIntervals(intervalsFor(events, threads, (event) => event.name === "Layout")),
    taskIntervals,
  )
  const styleIncludingLayout = intersectIntervals(
    unionIntervals(intervalsFor(events, threads, (event) => STYLE_RECALC_TRACE_EVENT_NAMES.has(event.name))),
    taskIntervals,
  )
  const style = subtractIntervals(styleIncludingLayout, layout)
  const scriptIncludingRender = intersectIntervals(
    unionIntervals(intervalsFor(events, threads, (event) => SCRIPT_TRACE_EVENT_NAMES.has(event.name))),
    taskIntervals,
  )
  const script = subtractIntervals(scriptIncludingRender, unionIntervals([...styleIncludingLayout, ...layout]))
  const scriptMetric = intervalMetric(script)
  const styleMetric = intervalMetric(style)
  const layoutMetric = intervalMetric(layout)
  const taskMetric = intervalMetric(taskIntervals)

  return {
    state: "measured",
    performance: {
      scriptMs: scriptMetric.ms,
      scriptCount: scriptMetric.count,
      recalcStyleMs: styleMetric.ms,
      recalcStyleCount: styleMetric.count,
      layoutMs: layoutMetric.ms,
      layoutCount: layoutMetric.count,
      taskMs: taskMetric.ms,
      taskCount: taskMetric.count,
    },
  }
}

function summarizeTraceTasks(events: TraceEvent[]) {
  return rendererRunTasks(events)
    .filter((task) => task.dur! >= 2_000)
    .map((task) => {
      const end = task.ts + task.dur!
      const spans = events
        .filter((event) =>
          event !== task &&
          event.ph === "X" &&
          event.pid === task.pid &&
          event.tid === task.tid &&
          event.dur &&
          event.dur >= 500 &&
          event.ts >= task.ts &&
          event.ts + event.dur <= end,
        )
        .map((event) => ({
          name: event.args?.data?.functionName || event.name,
          durationMs: round(event.dur! / 1_000),
          detail: traceDetail(event),
        }))
        .toSorted((left, right) => right.durationMs - left.durationMs)
        .slice(0, 8)
      const markers = events
        .filter((event) =>
          event.pid === task.pid &&
          event.tid === task.tid &&
          (event.ph === "I" || event.ph === "R") &&
          event.ts >= task.ts &&
          event.ts <= end &&
          event.name.startsWith("runtime."),
        )
        .map((event) => ({
          name: event.name,
          durationMs: 0,
          detail: traceDetail(event),
        }))
      return {
        durationMs: round(task.dur! / 1_000),
        events: [...spans, ...markers],
      }
    })
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .slice(0, 20)
}

function traceDetail(event: TraceEvent) {
  const source = event.args?.data?.scriptName || event.args?.data?.url
  if (!source) {
    if (!event.name.startsWith("v8.")) return
    const detail = JSON.stringify(event.args ?? {})
    return detail === "{}" ? undefined : detail.slice(0, 500)
  }
  const line = event.args?.data?.lineNumber
  const column = event.args?.data?.columnNumber
  if (line === undefined) return source
  return `${source}:${line}${column === undefined ? "" : `:${column}`}`
}

export async function readPerformanceMetrics(cdp: CDPSession) {
  const result = await cdp.send("Performance.getMetrics") as {
    metrics: Array<{ name: string; value: number }>
  }
  return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]))
}

export function performanceMetricDelta(before: Record<string, number>, after: Record<string, number>) {
  const metrics = {
    scriptMs: ["ScriptDuration", 1_000],
    v8CompileMs: ["V8CompileDuration", 1_000],
    taskMs: ["TaskDuration", 1_000],
    layoutMs: ["LayoutDuration", 1_000],
    recalcStyleMs: ["RecalcStyleDuration", 1_000],
    layoutCount: ["LayoutCount", 1],
    recalcStyleCount: ["RecalcStyleCount", 1],
    nodes: ["Nodes", 1],
    jsHeapUsedBytes: ["JSHeapUsedSize", 1],
  } satisfies Record<string, readonly [string, number]>
  return Object.fromEntries(
    Object.entries(metrics).map(([label, [name, scale]]) => [
      label,
      round(((after[name] ?? 0) - (before[name] ?? 0)) * scale),
    ]),
  )
}

function summarizeCpuProfile(profile: {
  nodes: Array<{
    id: number
    callFrame: {
      functionName: string
      url: string
      lineNumber: number
      columnNumber: number
    }
  }>
  samples?: number[]
  timeDeltas?: number[]
}) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const totals = new Map<number, { selfTimeMs: number; samples: number }>()
  profile.samples?.forEach((id, index) => {
    const current = totals.get(id) ?? { selfTimeMs: 0, samples: 0 }
    current.selfTimeMs += (profile.timeDeltas?.[index] ?? 0) / 1_000
    current.samples += 1
    totals.set(id, current)
  })
  return [...totals]
    .flatMap(([id, total]) => {
      const node = nodes.get(id)
      if (!node || node.callFrame.functionName === "(idle)") return []
      return [{
        functionName: node.callFrame.functionName || "(anonymous)",
        url: node.callFrame.url,
        lineNumber: node.callFrame.lineNumber,
        columnNumber: node.callFrame.columnNumber,
        selfTimeMs: round(total.selfTimeMs),
        samples: total.samples,
      }]
    })
    .toSorted((left, right) => right.selfTimeMs - left.selfTimeMs)
    .slice(0, 30)
}

// A normal recorder is installed after navigation, which misses module evaluation,
// hydration, and the first paint. Install this before page.goto so launch-project
// begins sampling in the new document before application scripts execute.
const pageLoadTraces = new WeakMap<Page, {
  cdp: CDPSession
  events: TraceEvent[]
  performanceBefore: Record<string, number>
  cpuProfileEnabled: boolean
}>()

export async function installPageLoadRecorder(page: Page) {
  await page.addInitScript(({ trace }) => {
    if (window !== window.top) return
    const w = window as unknown as Record<string, unknown>
    if (trace) {
      w.__claxedoPerfTrace = true
      w.__claxedoPerfRendererPhases = []
    }
    const frames: TimedDuration[] = []
    const loaf: TimedDuration[] = []
    const eventLoop: TimedDuration[] = []
    const startedAt = performance.now()
    let last = startedAt
    let running = true
    let rafId = 0
    let eventLoopLast = startedAt
    const eventLoopId = window.setInterval(() => {
      const now = performance.now()
      eventLoop.push({ startTime: eventLoopLast, duration: now - eventLoopLast })
      eventLoopLast = now
    }, 8)
    const tick = (time: number) => {
      if (!running) return
      frames.push({ startTime: last, duration: time - last })
      last = time
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    let observer: PerformanceObserver | undefined
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= startedAt) loaf.push({ startTime: entry.startTime, duration: entry.duration })
        }
      })
      observer.observe({ type: "long-animation-frame", buffered: true } as PerformanceObserverInit)
    } catch {}
    w.__perfPageLoadFrames = {
      frames,
      loaf,
      eventLoop,
      stop() {
        running = false
        cancelAnimationFrame(rafId)
        clearInterval(eventLoopId)
        observer?.disconnect()
      },
    }
  }, { trace: process.env.CLAXEDO_PERF_TRACE === "1" })
  const cdp = await page.context().newCDPSession(page)
  const events: TraceEvent[] = []
  await cdp.send("Performance.enable")
  const cpuProfileEnabled = process.env.CLAXEDO_PERF_CPU_PROFILE === "1"
  if (cpuProfileEnabled) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.start")
  }
  cdp.on("Tracing.dataCollected", (event) => {
    events.push(...event.value as unknown as TraceEvent[])
  })
  await cdp.send("Tracing.start", {
    categories: process.env.CLAXEDO_PERF_TRACE === "1"
      ? "__metadata,devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink.user_timing"
      : "__metadata,devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  })
  pageLoadTraces.set(page, {
    cdp,
    events,
    performanceBefore: await readPerformanceMetrics(cdp),
    cpuProfileEnabled,
  })
}

export async function stopPageLoadRecorder(page: Page, label: string, completionMs: number) {
  const result = await page.evaluate(() => {
    const rec = (window as unknown as Record<string, unknown>).__perfPageLoadFrames as {
      frames: TimedDuration[]
      loaf: TimedDuration[]
      eventLoop: TimedDuration[]
      stop: () => void
    } | undefined
    const phases = (window as unknown as Record<string, unknown>).__claxedoPerfRendererPhases
    if (!rec) return {
      frames: [] as TimedDuration[],
      loaf: [] as TimedDuration[],
      eventLoop: [] as TimedDuration[],
      phases: [] as Array<{ name: string; durationMs: number }>,
    }
    rec.stop()
    return {
      frames: rec.frames,
      loaf: rec.loaf,
      eventLoop: rec.eventLoop,
      phases: Array.isArray(phases) ? phases as Array<{ name: string; durationMs: number }> : [],
    }
  })
  const trace = pageLoadTraces.get(page)
  pageLoadTraces.delete(page)
  if (!trace) return buildFrameMetric(label, result.frames, result.loaf, completionMs, undefined, result.eventLoop)
  const performanceAfter = await readPerformanceMetrics(trace.cdp)
  const profile = trace.cpuProfileEnabled
    ? await trace.cdp.send("Profiler.stop") as {
        profile: {
          nodes: Array<{
            id: number
            callFrame: {
              functionName: string
              url: string
              lineNumber: number
              columnNumber: number
            }
          }>
          samples?: number[]
          timeDeltas?: number[]
        }
      }
    : undefined
  const complete = new Promise<void>((resolve) => trace.cdp.once("Tracing.tracingComplete", () => resolve()))
  await trace.cdp.send("Tracing.end")
  await complete
  await trace.cdp.detach()
  const causal: FrameCausalMetric | undefined = process.env.CLAXEDO_PERF_CAUSAL === "1"
    ? {
        dom: {
          nodesBefore: 0,
          nodesAfter: 0,
          composedNodesBefore: 0,
          composedNodesAfter: 0,
          nodesAdded: 0,
          nodesRemoved: 0,
          attributesChanged: 0,
        },
        longAnimationFrames: [],
        longTasks: [],
        events: [],
        resources: [],
        performance: performanceMetricDelta(trace.performanceBefore, performanceAfter),
        performanceSource: "cdp-cumulative-delta",
        ...(profile ? { cpuProfile: summarizeCpuProfile(profile.profile) } : {}),
        traceTasks: summarizeTraceTasks(trace.events),
        rendererPhases: result.phases,
      }
    : undefined
  return buildFrameMetric(
    label,
    result.frames,
    result.loaf,
    completionMs,
    causal,
    result.eventLoop,
    rendererRunTasks(trace.events).map((task) => task.dur! / 1_000),
  )
}

export function buildFrameMetric(
  label: string,
  frames: Array<number | TimedDuration>,
  loaf: Array<number | TimedDuration>,
  completionMs: number,
  causal?: FrameCausalMetric,
  eventLoop: TimedDuration[] = [],
  mainThreadTasks: number[] = [],
): FrameMetric {
  // Recorder setup is cleared before normal interactions. For navigation, the
  // first interval includes application bootstrap. Long rAF gaps can also mean
  // the headless renderer was descheduled by the host. Chromium's LoAF entry
  // attributes >=50ms main-thread animation work, so it replaces the matching
  // long rAF interval in the gated population. An 8ms event-loop heartbeat
  // distinguishes shorter application stalls from headless scheduler cadence:
  // this Chromium build emits 17.8ms rAF on about:blank while its heartbeat
  // remains at 8ms. Scheduler-only gaps stay in raw evidence and out of the app gate.
  // Any excess >=50ms rAF gaps are retained separately as measurement-quality
  // evidence, not blamed on the app.
  // Timestamp overlap is the evidence that a LoAF replaces an rAF gap. Numeric
  // inputs remain supported for focused unit tests and use duration proximity.
  const observedIntervals = frames.map(timedDuration).filter(validTimedDuration)
  const longFrames = loaf.map(timedDuration).filter(validTimedDuration)
  const attributedLongGaps = new Set<number>()
  for (const frame of observedIntervals) {
    if (frame.duration < 50) continue
    if (longFrames.some((longFrame) => timingsMatch(frame, longFrame))) attributedLongGaps.add(frame.startTime)
  }
  const tracedTasks = mainThreadTasks.filter((duration) => Number.isFinite(duration) && duration >= 0)
  const hasHeartbeat = eventLoop.length > 0 && tracedTasks.length === 0
  const mainThreadBlocked = new Set(
    observedIntervals
      .filter((frame) => frame.duration > FRAME_60HZ_MS && frame.duration < 50)
      .filter((frame) => eventLoop.some(
        (interval) => interval.duration > FRAME_60HZ_MS && timingsOverlap(frame, interval),
      ))
      .map((frame) => frame.startTime),
  )
  const unattributedSchedulingGaps = observedIntervals
    .filter((frame) => {
      if (frame.duration >= 50) return !attributedLongGaps.has(frame.startTime)
      if (tracedTasks.length > 0) return frame.duration > FRAME_60HZ_MS
      if (!hasHeartbeat || frame.duration <= FRAME_60HZ_MS) return false
      return !mainThreadBlocked.has(frame.startTime)
    })
    .map((frame) => frame.duration)
  const intervals = tracedTasks.length > 0
    ? tracedTasks
    : [
        ...observedIntervals
          .filter((frame) => frame.duration < 50)
          .filter((frame) => !hasHeartbeat || frame.duration <= FRAME_60HZ_MS || mainThreadBlocked.has(frame.startTime))
          .map((frame) => frame.duration),
        ...longFrames.map((frame) => frame.duration),
      ]
  const worstFrameMs = Math.max(0, ...intervals)
  const p95FrameMs = percentile(intervals, 95)
  const framesOver833 = intervals.filter((value) => value > FRAME_120HZ_MS).length
  const framesOver1667 = intervals.filter((value) => value > FRAME_60HZ_MS).length
  return {
    label,
    worstFrameMs: round(worstFrameMs),
    p95FrameMs: round(p95FrameMs),
    framesOver833,
    framesOver1667,
    sampleCount: intervals.length,
    completionMs: round(completionMs),
    verdict: verdictFor(p95FrameMs, framesOver1667, worstFrameMs),
    observedFrameIntervalsMs: observedIntervals.map((frame) => round(frame.duration)),
    ...(tracedTasks.length > 0 ? { mainThreadTasksMs: tracedTasks.map(round) } : {}),
    frameIntervalsMs: intervals.map(round),
    longAnimationFrameMs: longFrames.map((frame) => round(frame.duration)),
    unattributedSchedulingGapsMs: unattributedSchedulingGaps.map(round),
    rendererScheduling: observedIntervals
      .filter((frame) => frame.duration > FRAME_60HZ_MS)
      .map((frame) => ({
        rafIntervalMs: round(frame.duration),
        maxOverlappingEventLoopIntervalMs: round(Math.max(
          0,
          ...eventLoop
            .filter((interval) => timingsOverlap(frame, interval))
            .map((interval) => interval.duration),
        )),
      })),
    ...(causal ? { causal } : {}),
  }
}

function timedDuration(value: number | TimedDuration, index: number): TimedDuration {
  if (typeof value !== "number") return value
  return { startTime: -(index + 1), duration: value }
}

function validTimedDuration(value: TimedDuration) {
  return Number.isFinite(value.startTime) && Number.isFinite(value.duration) && value.duration >= 0
}

function timingsMatch(frame: TimedDuration, longFrame: TimedDuration) {
  if (frame.startTime < 0 || longFrame.startTime < 0) {
    return Math.abs(frame.duration - longFrame.duration) <= Math.max(2, frame.duration * 0.05)
  }
  return timingsOverlap(frame, longFrame)
}

function timingsOverlap(left: TimedDuration, right: TimedDuration) {
  return left.startTime <= right.startTime + right.duration
    && right.startTime <= left.startTime + left.duration
}

export function mergeFrameMetrics(label: string, metrics: FrameMetric[]): FrameMetric {
  if (metrics.length === 1) return metrics[0]!
  const worstFrameMs = Math.max(0, ...metrics.map((metric) => metric.worstFrameMs))
  const observedFrameIntervalsMs = metrics.flatMap((metric) => metric.observedFrameIntervalsMs ?? [])
  const mainThreadTasksMs = metrics.flatMap((metric) => metric.mainThreadTasksMs ?? [])
  const frameIntervalsMs = metrics.flatMap((metric) => metric.frameIntervalsMs ?? [])
  const longAnimationFrameMs = metrics.flatMap((metric) => metric.longAnimationFrameMs ?? [])
  const unattributedSchedulingGapsMs = metrics.flatMap((metric) => metric.unattributedSchedulingGapsMs ?? [])
  const rendererScheduling = metrics.flatMap((metric) => metric.rendererScheduling ?? [])
  const mergedPerformance = mergePerformanceMeasurement(metrics)
  const p95FrameMs = frameIntervalsMs.length > 0
    ? percentile(frameIntervalsMs, 95)
    : Math.max(0, ...metrics.map((metric) => metric.p95FrameMs))
  const framesOver833 = frameIntervalsMs.length > 0
    ? frameIntervalsMs.filter((value) => value > FRAME_120HZ_MS).length
    : metrics.reduce((sum, metric) => sum + metric.framesOver833, 0)
  const framesOver1667 = frameIntervalsMs.length > 0
    ? frameIntervalsMs.filter((value) => value > FRAME_60HZ_MS).length
    : metrics.reduce((sum, metric) => sum + metric.framesOver1667, 0)
  return {
    label,
    worstFrameMs: round(worstFrameMs),
    p95FrameMs: round(p95FrameMs),
    framesOver833,
    framesOver1667,
    sampleCount: frameIntervalsMs.length || metrics.reduce((sum, metric) => sum + metric.sampleCount, 0),
    completionMs: round(metrics.reduce((sum, metric) => sum + metric.completionMs, 0) / metrics.length),
    verdict: verdictFor(
      p95FrameMs,
      framesOver1667,
      worstFrameMs,
    ),
    ...(frameIntervalsMs.length > 0 ? { frameIntervalsMs } : {}),
    ...(mainThreadTasksMs.length > 0 ? { mainThreadTasksMs } : {}),
    ...(longAnimationFrameMs.length > 0 ? { longAnimationFrameMs } : {}),
    ...(unattributedSchedulingGapsMs.length > 0 ? { unattributedSchedulingGapsMs } : {}),
    ...(rendererScheduling.length > 0 ? { rendererScheduling } : {}),
    runs: metrics.flatMap((metric) => metric.runs ?? [frameRunMetric(metric)]),
    ...(observedFrameIntervalsMs.length > 0 ? { observedFrameIntervalsMs } : {}),
    ...(metrics.some((metric) => metric.causal)
      ? {
          causal: {
            dom: {
              nodesBefore: Math.max(...metrics.map((metric) => metric.causal?.dom.nodesBefore ?? 0)),
              nodesAfter: Math.max(...metrics.map((metric) => metric.causal?.dom.nodesAfter ?? 0)),
              composedNodesBefore: Math.max(...metrics.map((metric) => metric.causal?.dom.composedNodesBefore ?? 0)),
              composedNodesAfter: Math.max(...metrics.map((metric) => metric.causal?.dom.composedNodesAfter ?? 0)),
              nodesAdded: metrics.reduce((sum, metric) => sum + (metric.causal?.dom.nodesAdded ?? 0), 0),
              nodesRemoved: metrics.reduce((sum, metric) => sum + (metric.causal?.dom.nodesRemoved ?? 0), 0),
              attributesChanged: metrics.reduce((sum, metric) => sum + (metric.causal?.dom.attributesChanged ?? 0), 0),
            },
            longAnimationFrames: metrics.flatMap((metric) => metric.causal?.longAnimationFrames ?? []),
            longTasks: metrics.flatMap((metric) => metric.causal?.longTasks ?? []),
            events: metrics.flatMap((metric) => metric.causal?.events ?? []),
            resources: metrics.flatMap((metric) => metric.causal?.resources ?? []),
            ...mergedPerformance,
            cpuProfile: metrics.flatMap((metric) => metric.causal?.cpuProfile ?? []),
            traceTasks: metrics
              .flatMap((metric) => metric.causal?.traceTasks ?? [])
              .toSorted((left, right) => right.durationMs - left.durationMs)
              .slice(0, 20),
            rendererPhases: metrics.flatMap((metric) => metric.causal?.rendererPhases ?? []),
          },
        }
      : {}),
  }
}

function mergePerformanceMeasurement(metrics: FrameMetric[]): Pick<
  FrameCausalMetric,
  "performance" | "performanceSource" | "performanceUnavailableReason"
> {
  const causal = metrics.flatMap((metric) => metric.causal ? [metric.causal] : [])
  if (causal.length === 0) return {}
  const unavailable = causal.filter((metric) => !metric.performance)
  if (unavailable.length > 0) {
    const reasons = [...new Set(unavailable.map((metric) =>
      metric.performanceUnavailableReason ?? "causal run had no renderer performance measurement"))]
    return { performanceUnavailableReason: reasons.join("; ") }
  }
  const sources = [...new Set(causal.flatMap((metric) => metric.performanceSource ? [metric.performanceSource] : []))]
  if (sources.length !== 1) {
    return { performanceUnavailableReason: "causal runs did not share one renderer performance source" }
  }
  const entries = metrics.flatMap((metric) => Object.entries(metric.causal?.performance ?? {}))
  return {
    performance: Object.fromEntries(
      [...new Set(entries.map(([name]) => name))].map((name) => [
        name,
        round(entries.filter(([key]) => key === name).reduce((sum, [, value]) => sum + value, 0)),
      ]),
    ),
    performanceSource: sources[0],
  }
}

function frameRunMetric(metric: FrameMetric): FrameRunMetric {
  return {
    label: metric.label,
    worstFrameMs: metric.worstFrameMs,
    p95FrameMs: metric.p95FrameMs,
    framesOver833: metric.framesOver833,
    framesOver1667: metric.framesOver1667,
    sampleCount: metric.sampleCount,
    completionMs: metric.completionMs,
    verdict: metric.verdict,
    ...(metric.observedFrameIntervalsMs ? { observedFrameIntervalsMs: metric.observedFrameIntervalsMs } : {}),
    ...(metric.mainThreadTasksMs ? { mainThreadTasksMs: metric.mainThreadTasksMs } : {}),
    ...(metric.frameIntervalsMs ? { frameIntervalsMs: metric.frameIntervalsMs } : {}),
    ...(metric.longAnimationFrameMs ? { longAnimationFrameMs: metric.longAnimationFrameMs } : {}),
    ...(metric.unattributedSchedulingGapsMs
      ? { unattributedSchedulingGapsMs: metric.unattributedSchedulingGapsMs }
      : {}),
    ...(metric.rendererScheduling ? { rendererScheduling: metric.rendererScheduling } : {}),
  }
}

function percentile(values: number[], rank: number) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  const index = Math.ceil((rank / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
