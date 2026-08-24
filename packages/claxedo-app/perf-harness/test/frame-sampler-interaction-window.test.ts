import { afterAll, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { CDPSession, Page } from "playwright-core"
import {
  measureInteraction,
  mergeFrameMetrics,
  trustedWindowRendererPerformance,
  startRecorder,
  traceEventsInTrustedWindow,
  type FrameCausalMetric,
  type FrameMetric,
} from "../src/frame-sampler"

beforeAll(() => GlobalRegistrator.register())
afterAll(() => GlobalRegistrator.unregister())

type Recorder = {
  frames: Array<{ startTime: number; duration: number }>
  loaf: Array<{ startTime: number; duration: number }>
  eventLoop: Array<{ startTime: number; duration: number }>
  causal: FrameCausalMetric
  armOnNextTrustedPointerdown: (mark: string) => void
  trustedPointerdownAt: () => number | undefined
  stop: () => void
}

function recorder() {
  return (window as unknown as { __perfFrames: Recorder }).__perfFrames
}

function trustedPointerdown(at: number) {
  const event = new PointerEvent("pointerdown", { bubbles: true })
  Object.defineProperties(event, {
    isTrusted: { value: true },
    timeStamp: { value: at },
  })
  window.dispatchEvent(event)
}

function frameWithCausal(causal: FrameCausalMetric): FrameMetric {
  return {
    label: "trusted",
    worstFrameMs: 1,
    p95FrameMs: 1,
    framesOver833: 0,
    framesOver1667: 0,
    sampleCount: 1,
    completionMs: 1,
    verdict: "green",
    causal,
  }
}

function causal(overrides: Partial<FrameCausalMetric>): FrameCausalMetric {
  return {
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
    ...overrides,
  }
}

test("trusted pointerdown atomically resets frame, causal, resource, and DOM state", async () => {
  document.body.replaceChildren(document.createElement("main"))
  await startRecorder({
    async evaluate(callback: (argument: unknown) => unknown, argument: unknown) {
      return callback(argument)
    },
  } as unknown as Page, { captureCausal: true, captureHeartbeat: false, captureTrace: true })
  const rec = recorder()
  rec.frames.push({ startTime: 1, duration: 2 })
  rec.loaf.push({ startTime: 1, duration: 50 })
  rec.eventLoop.push({ startTime: 1, duration: 20 })
  rec.causal.longAnimationFrames.push({
    startTime: 1,
    duration: 50,
    blockingDuration: 1,
    renderStart: 2,
    styleAndLayoutStart: 3,
    scripts: [],
  })
  rec.causal.longTasks.push({ name: "setup", startTime: 1, duration: 50 })
  rec.causal.events.push({ name: "click", startTime: 1, duration: 10, interactionId: 1 })
  rec.causal.resources.push({
    name: "/setup",
    startTime: 1,
    initiatorType: "fetch",
    duration: 10,
    transferSize: 1,
    decodedBodySize: 1,
  })
  Object.assign(rec.causal.dom, {
    nodesAdded: 7,
    nodesRemoved: 8,
    attributesChanged: 9,
  })
  ;(window as unknown as { __claxedoPerfRendererPhases: unknown[] }).__claxedoPerfRendererPhases = [{
    name: "setup",
    durationMs: 20,
  }]

  const addedBeforeArm = document.createElement("section")
  document.body.append(addedBeforeArm)
  rec.armOnNextTrustedPointerdown("frame-sampler-reset-test")
  window.dispatchEvent(new PointerEvent("pointerdown"))
  expect(rec.trustedPointerdownAt()).toBeUndefined()

  const at = performance.now()
  trustedPointerdown(at)
  expect(rec.trustedPointerdownAt()).toBe(at)
  expect(rec.frames).toEqual([])
  expect(rec.loaf).toEqual([])
  expect(rec.eventLoop).toEqual([])
  expect(rec.causal.longAnimationFrames).toEqual([])
  expect(rec.causal.longTasks).toEqual([])
  expect(rec.causal.events).toEqual([])
  expect(rec.causal.resources).toEqual([])
  expect(rec.causal.dom).toMatchObject({
    nodesBefore: document.getElementsByTagName("*").length,
    nodesAfter: 0,
    composedNodesBefore: document.querySelectorAll("*").length,
    composedNodesAfter: 0,
    nodesAdded: 0,
    nodesRemoved: 0,
    attributesChanged: 0,
  })
  expect((window as unknown as { __claxedoPerfRendererPhases: unknown[] }).__claxedoPerfRendererPhases).toEqual([])

  document.body.append(document.createElement("aside"))
  await Promise.resolve()
  expect(rec.causal.dom.nodesAdded).toBe(1)
  rec.stop()
  performance.clearMarks("frame-sampler-reset-test")
})

function fakePage(includeRendererWork = true) {
  let tracingComplete: (() => void) | undefined
  let dataCollected: ((event: { value: unknown[] }) => void) | undefined
  const cdp = {
    async send(method: string) {
      if (method === "Performance.getMetrics") return { metrics: [] }
      if (method === "Tracing.end") {
        const marks = performance.getEntriesByType("mark")
        const trusted = marks.at(-1)
        dataCollected?.({
          value: [
            { name: "thread_name", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "CrRendererMain" } },
            ...marks.map((mark) => ({ name: mark.name, ph: "R", ts: mark.startTime * 1_000, pid: 1, tid: 1 })),
            ...(trusted && includeRendererWork
              ? [
                  { name: "RunTask", ph: "X", ts: trusted.startTime * 1_000, dur: 1_000, pid: 1, tid: 1 },
                  { name: "FunctionCall", ph: "X", ts: trusted.startTime * 1_000, dur: 500, pid: 1, tid: 1 },
                ]
              : []),
          ],
        })
        tracingComplete?.()
      }
      return {}
    },
    on(event: string, callback: (event: { value: unknown[] }) => void) {
      if (event === "Tracing.dataCollected") dataCollected = callback
    },
    once(event: string, callback: () => void) {
      if (event === "Tracing.tracingComplete") tracingComplete = callback
    },
    async detach() {},
  } as unknown as CDPSession
  return {
    async evaluate<T, A>(callback: (argument: A) => T | Promise<T>, argument?: A) {
      return await callback(argument as A)
    },
    context() {
      return { async newCDPSession() { return cdp } }
    },
  } as unknown as Page
}

test("measureInteraction uses the completion returned by the trusted page-clock action", async () => {
  const previous = process.env.CLAXEDO_PERF_CAUSAL
  process.env.CLAXEDO_PERF_CAUSAL = "1"
  try {
    const metric = await measureInteraction(fakePage(), "trusted-test", async () => {
      trustedPointerdown(performance.now())
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return 37.25
    }, { armAt: "trusted-pointerdown" })

    expect(metric.completionMs).toBe(37.25)
    expect(metric.causal?.resources).toEqual([])
    expect(metric.causal?.dom.nodesAdded).toBe(0)
    expect(metric.causal?.performanceSource).toBe("trusted-window-trace")
    expect(metric.causal?.performance).toMatchObject({
      scriptMs: 0.5,
      recalcStyleMs: 0,
      layoutMs: 0,
      taskMs: 1,
    })
    expect(metric.causal?.performanceUnavailableReason).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.CLAXEDO_PERF_CAUSAL
    else process.env.CLAXEDO_PERF_CAUSAL = previous
  }
})

test("measureInteraction exposes missing trusted renderer work instead of synthesizing zero", async () => {
  const previous = process.env.CLAXEDO_PERF_CAUSAL
  process.env.CLAXEDO_PERF_CAUSAL = "1"
  try {
    const metric = await measureInteraction(fakePage(false), "trusted-missing-work", async () => {
      trustedPointerdown(performance.now())
      return 10
    }, { armAt: "trusted-pointerdown" })

    expect(metric.causal?.performance).toBeUndefined()
    expect(metric.causal?.performanceSource).toBeUndefined()
    expect(metric.causal?.performanceUnavailableReason).toBe("trusted trace had no CrRendererMain RunTask")
  } finally {
    if (previous === undefined) delete process.env.CLAXEDO_PERF_CAUSAL
    else process.env.CLAXEDO_PERF_CAUSAL = previous
  }
})

test("trusted trace cropping excludes pre-mark tasks and clips a boundary task", () => {
  const cropped = traceEventsInTrustedWindow([
    { name: "thread_name", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "CrRendererMain" } },
    { name: "RunTask.pre", ph: "X", ts: 800, dur: 100, pid: 1, tid: 1 },
    { name: "RunTask.boundary", ph: "X", ts: 900, dur: 200, pid: 1, tid: 1 },
    { name: "trusted-mark", ph: "R", ts: 1_000, pid: 1, tid: 1 },
    { name: "RunTask.inside", ph: "X", ts: 1_200, dur: 300, pid: 1, tid: 1 },
    { name: "RunTask.late", ph: "X", ts: 2_100, dur: 100, pid: 1, tid: 1 },
  ], "trusted-mark", 1)

  expect(cropped.map((event) => event.name)).toEqual([
    "thread_name",
    "RunTask.boundary",
    "trusted-mark",
    "RunTask.inside",
  ])
  expect(cropped.find((event) => event.name === "RunTask.boundary")).toMatchObject({ ts: 1_000, dur: 100 })
})

test("trusted renderer work clips every phase to the exact interaction boundary", () => {
  const cropped = traceEventsInTrustedWindow([
    { name: "thread_name", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "CrRendererMain" } },
    { name: "trusted-mark", ph: "R", ts: 1_000, pid: 1, tid: 1 },
    { name: "RunTask.boundary", ph: "X", ts: 800, dur: 1_400, pid: 1, tid: 1 },
    { name: "FunctionCall", ph: "X", ts: 800, dur: 700, pid: 1, tid: 1 },
    { name: "UpdateLayoutTree", ph: "X", ts: 1_300, dur: 400, pid: 1, tid: 1 },
    { name: "Layout", ph: "X", ts: 1_700, dur: 500, pid: 1, tid: 1 },
  ], "trusted-mark", 1)

  expect(trustedWindowRendererPerformance(cropped)).toEqual({
    state: "measured",
    performance: {
      scriptMs: 0.3,
      scriptCount: 1,
      recalcStyleMs: 0.4,
      recalcStyleCount: 1,
      layoutMs: 0.3,
      layoutCount: 1,
      taskMs: 1,
      taskCount: 1,
    },
  })
})

test("trusted renderer work unions nested spans and never double-counts phase overlap", () => {
  expect(trustedWindowRendererPerformance([
    { name: "thread_name", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "CrRendererMain" } },
    { name: "RunTask.outer", ph: "X", ts: 0, dur: 2_000, pid: 1, tid: 1 },
    { name: "RunTask.nested", ph: "X", ts: 100, dur: 1_800, pid: 1, tid: 1 },
    { name: "EventDispatch", ph: "X", ts: 100, dur: 1_800, pid: 1, tid: 1 },
    { name: "FunctionCall", ph: "X", ts: 200, dur: 1_600, pid: 1, tid: 1 },
    { name: "UpdateLayoutTree", ph: "X", ts: 400, dur: 500, pid: 1, tid: 1 },
    { name: "RecalculateStyles", ph: "X", ts: 500, dur: 300, pid: 1, tid: 1 },
    { name: "Layout", ph: "X", ts: 700, dur: 400, pid: 1, tid: 1 },
  ])).toEqual({
    state: "measured",
    performance: {
      scriptMs: 1.1,
      scriptCount: 2,
      recalcStyleMs: 0.3,
      recalcStyleCount: 1,
      layoutMs: 0.4,
      layoutCount: 1,
      taskMs: 2,
      taskCount: 1,
    },
  })
})

test("trusted renderer work distinguishes missing task evidence from measured zero phase work", () => {
  const thread = { name: "thread_name", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "CrRendererMain" } }
  expect(trustedWindowRendererPerformance([
    { name: "RunTask", ph: "X", ts: 0, dur: 500, pid: 1, tid: 1 },
  ])).toEqual({
    state: "unavailable",
    reason: "trusted trace had no CrRendererMain thread",
  })
  expect(trustedWindowRendererPerformance([thread])).toEqual({
    state: "unavailable",
    reason: "trusted trace had no CrRendererMain RunTask",
  })
  expect(trustedWindowRendererPerformance([
    thread,
    { name: "RunTask", ph: "X", ts: 0, dur: 500, pid: 1, tid: 1 },
  ])).toEqual({
    state: "measured",
    performance: {
      scriptMs: 0,
      scriptCount: 0,
      recalcStyleMs: 0,
      recalcStyleCount: 0,
      layoutMs: 0,
      layoutCount: 0,
      taskMs: 0.5,
      taskCount: 1,
    },
  })
})

test("merged trusted runs preserve explicit absence instead of publishing a partial zero-like result", () => {
  const measured = mergeFrameMetrics("trusted", [
    frameWithCausal(causal({
      performance: { scriptMs: 0.5, scriptCount: 1 },
      performanceSource: "trusted-window-trace",
    })),
    frameWithCausal(causal({
      performance: { scriptMs: 0.75, scriptCount: 2 },
      performanceSource: "trusted-window-trace",
    })),
  ])
  const merged = mergeFrameMetrics("trusted", [
    frameWithCausal(causal({
      performance: { scriptMs: 0.5, scriptCount: 1 },
      performanceSource: "trusted-window-trace",
    })),
    frameWithCausal(causal({
      performanceUnavailableReason: "trusted trace had no CrRendererMain RunTask",
    })),
  ])

  expect(measured.causal?.performance).toEqual({ scriptMs: 1.25, scriptCount: 3 })
  expect(measured.causal?.performanceSource).toBe("trusted-window-trace")
  expect(measured.causal?.performanceUnavailableReason).toBeUndefined()
  expect(merged.causal?.performance).toBeUndefined()
  expect(merged.causal?.performanceSource).toBeUndefined()
  expect(merged.causal?.performanceUnavailableReason).toBe("trusted trace had no CrRendererMain RunTask")
})
