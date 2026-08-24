import { afterAll, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { CDPSession, Page } from "playwright-core"
import {
  measureInteraction,
  startRecorder,
  traceEventsInTrustedWindow,
  type FrameCausalMetric,
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

function fakePage() {
  let tracingComplete: (() => void) | undefined
  let dataCollected: ((event: { value: unknown[] }) => void) | undefined
  const cdp = {
    async send(method: string) {
      if (method === "Performance.getMetrics") return { metrics: [] }
      if (method === "Tracing.end") {
        const marks = performance.getEntriesByType("mark")
        dataCollected?.({
          value: [
            { name: "thread_name", ph: "M", ts: 0, pid: 1, tid: 1, args: { name: "CrRendererMain" } },
            ...marks.map((mark) => ({ name: mark.name, ph: "R", ts: mark.startTime * 1_000, pid: 1, tid: 1 })),
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
