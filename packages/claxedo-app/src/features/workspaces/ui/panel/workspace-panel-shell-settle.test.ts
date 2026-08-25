import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"

import { createShellSettle } from "./workspace-panel-shell-settle"

/**
 * The gate is written against `requestAnimationFrame`, `requestIdleCallback`
 * and transition events, so the test drives those directly rather than waiting
 * on real frames: the property under test is the ORDER the gate waits in, and a
 * real clock would only make that order slower to observe, not clearer.
 *
 * That order is load-bearing and was untested. It is what decides whether the
 * panel body's construction lands on the frames a session activation is still
 * using — the `FireAnimationFrame` task that owns 40-80 ms of an `open_file`
 * cold switch window is `openGate` below.
 */
type Scheduler = {
  frames: Array<() => void>
  idles: Array<{ run: () => void; timeout: number }>
  runFrame: () => void
  runIdle: () => void
}

type SchedulerCarrier = {
  requestAnimationFrame?: unknown
  cancelAnimationFrame?: unknown
  requestIdleCallback?: unknown
  cancelIdleCallback?: unknown
  window?: SchedulerCarrier
}

function schedulerCarriers(): SchedulerCarrier[] {
  // Both carriers: happy-dom installs its own `window`, and the gate resolves
  // these names off whichever one the runtime hands it.
  const root: SchedulerCarrier = globalThis
  return root.window && root.window !== root ? [root, root.window] : [root]
}

function withScheduler<T>(body: (scheduler: Scheduler) => T): T {
  const frames: Array<() => void> = []
  const idles: Array<{ run: () => void; timeout: number }> = []
  const carriers = schedulerCarriers()
  const saved = carriers.map((carrier) => ({
    carrier,
    raf: carrier.requestAnimationFrame,
    caf: carrier.cancelAnimationFrame,
    ric: carrier.requestIdleCallback,
    cic: carrier.cancelIdleCallback,
  }))
  for (const carrier of carriers) {
    carrier.requestAnimationFrame = (callback: () => void) => frames.push(callback)
    carrier.cancelAnimationFrame = () => {}
    carrier.requestIdleCallback = (callback: () => void, options?: { timeout?: number }) => {
      idles.push({ run: callback, timeout: options?.timeout ?? 0 })
      return idles.length
    }
    carrier.cancelIdleCallback = () => {}
  }
  try {
    return body({
      frames,
      idles,
      runFrame: () => frames.shift()?.(),
      runIdle: () => idles.shift()?.run(),
    })
  } finally {
    for (const entry of saved) {
      entry.carrier.requestAnimationFrame = entry.raf
      entry.carrier.cancelAnimationFrame = entry.caf
      entry.carrier.requestIdleCallback = entry.ric
      entry.carrier.cancelIdleCallback = entry.cic
    }
  }
}

/** A real element, so the gate's transition listeners attach to something. */
const element = () => document.createElement("div")

describe("createShellSettle", () => {
  // The gate arms from a `createEffect`, which Solid flushes when the root's
  // update completes — so every test builds the gate, lets `createRoot` return,
  // and only then drives the scheduler.
  const mount = (input: Parameters<typeof createShellSettle>[0]) =>
    createRoot((dispose) => ({ settle: createShellSettle(input), dispose }))

  test("opens after the shell's motion, one idle slice and one more frame", () => {
    withScheduler((scheduler) => {
      const { settle, dispose } = mount({ open: () => true, element, motionMs: 0 })
      expect(settle.settled()).toBe(false)
      // Step 1: the shell's own motion — two frames with no transition.
      scheduler.runFrame()
      scheduler.runFrame()
      expect(settle.settled()).toBe(false)
      // Step 2: the idle slice.
      scheduler.runIdle()
      expect(settle.settled()).toBe(false)
      // Step 3: one more frame, so whatever was waiting on the free thread
      // presents before the body's construction takes it back.
      scheduler.runFrame()
      expect(settle.settled()).toBe(true)
      dispose()
    })
  })

  test("a closed panel never arms the gate", () => {
    withScheduler((scheduler) => {
      const { settle, dispose } = mount({ open: () => false, element, motionMs: 0 })
      expect(settle.settled()).toBe(false)
      expect(scheduler.frames.length).toBe(0)
      dispose()
    })
  })
})
