import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  HARNESS_REPROBE_INTERVAL_MS,
  HARNESS_REPROBE_MAX_ATTEMPTS,
  startHarnessReprobeLoop,
  type ReprobeScheduler,
} from "../../session/harness/reprobe"
import { watchHarnessReprobe } from "./harness-reprobe"

/**
 * Deterministic hand-cranked scheduler. The re-probe loop keeps at most one
 * timer armed at a time (self-rearming), so `tick()` drains whatever is
 * currently scheduled — running a tick may schedule the next one.
 */
function makeManualScheduler(): {
  schedule: ReprobeScheduler
  pendingCount: () => number
  tick: () => void
  lastMs: () => number | undefined
} {
  let seq = 0
  let last: number | undefined
  const pending = new Map<number, () => void>()
  return {
    schedule: (handler, ms) => {
      last = ms
      const id = ++seq
      pending.set(id, handler)
      return () => {
        pending.delete(id)
      }
    },
    pendingCount: () => pending.size,
    lastMs: () => last,
    tick: () => {
      for (const id of [...pending.keys()]) {
        const fn = pending.get(id)
        pending.delete(id)
        fn?.()
      }
    },
  }
}

const flush = () => Promise.resolve()

describe("startHarnessReprobeLoop", () => {
  test("does not fire synchronously and arms exactly one timer at the configured interval", () => {
    const timers = makeManualScheduler()
    const attempts: number[] = []
    const loop = startHarnessReprobeLoop({
      onReprobe: (n) => attempts.push(n),
      onExhausted: () => attempts.push(-1),
      intervalMs: 1000,
      maxAttempts: 40,
      schedule: timers.schedule,
    })
    // Nothing runs on start — the first probe waits a full interval.
    expect(attempts).toEqual([])
    expect(timers.pendingCount()).toBe(1)
    expect(timers.lastMs()).toBe(1000)
    loop.cancel()
  })

  test("fires one re-probe per interval with incrementing attempt numbers", () => {
    const timers = makeManualScheduler()
    const attempts: number[] = []
    const loop = startHarnessReprobeLoop({
      onReprobe: (n) => attempts.push(n),
      onExhausted: () => {},
      intervalMs: 1000,
      maxAttempts: 40,
      schedule: timers.schedule,
    })
    timers.tick()
    timers.tick()
    timers.tick()
    expect(attempts).toEqual([1, 2, 3])
    loop.cancel()
  })

  test("caps at maxAttempts, then transitions to exhausted exactly once and stops re-arming", () => {
    const timers = makeManualScheduler()
    let reprobes = 0
    let exhausted = 0
    startHarnessReprobeLoop({
      onReprobe: () => {
        reprobes += 1
      },
      onExhausted: () => {
        exhausted += 1
      },
      intervalMs: 1000,
      maxAttempts: 3,
      schedule: timers.schedule,
    })
    timers.tick() // attempt 1
    timers.tick() // attempt 2
    timers.tick() // attempt 3
    expect(reprobes).toBe(3)
    expect(exhausted).toBe(0)
    expect(timers.pendingCount()).toBe(1) // one more tick armed

    timers.tick() // cap reached -> onExhausted, no re-arm
    expect(reprobes).toBe(3)
    expect(exhausted).toBe(1)
    expect(timers.pendingCount()).toBe(0)

    timers.tick() // nothing scheduled -> no-op
    expect(reprobes).toBe(3)
    expect(exhausted).toBe(1)
  })

  test("cancel stops further re-probes, clears the armed timer, and is idempotent", () => {
    const timers = makeManualScheduler()
    let reprobes = 0
    const loop = startHarnessReprobeLoop({
      onReprobe: () => {
        reprobes += 1
      },
      onExhausted: () => {},
      intervalMs: 1000,
      maxAttempts: 40,
      schedule: timers.schedule,
    })
    timers.tick()
    expect(reprobes).toBe(1)
    loop.cancel()
    expect(timers.pendingCount()).toBe(0)
    timers.tick()
    expect(reprobes).toBe(1)
    loop.cancel() // idempotent, no throw
  })

  test("exposes production interval/cap defaults (~40 attempts over ~60s)", () => {
    expect(HARNESS_REPROBE_INTERVAL_MS).toBe(1500)
    expect(HARNESS_REPROBE_MAX_ATTEMPTS).toBe(40)
    expect(HARNESS_REPROBE_MAX_ATTEMPTS * HARNESS_REPROBE_INTERVAL_MS).toBe(60_000)
  })
})

describe("watchHarnessReprobe", () => {
  test("re-probes only while active and cancels the loop the moment it settles", async () => {
    const timers = makeManualScheduler()
    const [polling, setPolling] = createSignal(false)
    let reprobes = 0
    let exhausted = 0
    const dispose = createRoot((d) => {
      watchHarnessReprobe({
        active: () => polling(),
        reprobe: () => {
          reprobes += 1
        },
        onExhausted: () => {
          exhausted += 1
        },
        intervalMs: 1000,
        maxAttempts: 40,
        schedule: timers.schedule,
      })
      return d
    })

    // Not polling -> no loop armed.
    await flush()
    expect(timers.pendingCount()).toBe(0)

    // Enter polling -> loop starts.
    setPolling(true)
    await flush()
    expect(timers.pendingCount()).toBe(1)
    timers.tick()
    timers.tick()
    expect(reprobes).toBe(2)

    // Settle -> effect re-runs, onCleanup cancels the loop.
    setPolling(false)
    await flush()
    expect(timers.pendingCount()).toBe(0)
    timers.tick()
    expect(reprobes).toBe(2) // no further probes after settle
    expect(exhausted).toBe(0)

    dispose()
  })

  test("hands off to the error affordance when a never-settling harness exhausts the cap", async () => {
    const timers = makeManualScheduler()
    const [polling] = createSignal(true)
    let reprobes = 0
    let exhausted = 0
    const dispose = createRoot((d) => {
      watchHarnessReprobe({
        active: () => polling(),
        reprobe: () => {
          reprobes += 1
        },
        onExhausted: () => {
          exhausted += 1
        },
        intervalMs: 1000,
        maxAttempts: 2,
        schedule: timers.schedule,
      })
      return d
    })

    await flush()
    timers.tick() // attempt 1
    timers.tick() // attempt 2
    timers.tick() // cap -> exhausted
    expect(reprobes).toBe(2)
    expect(exhausted).toBe(1)
    expect(timers.pendingCount()).toBe(0)

    dispose()
  })

  test("cleanup on owner disposal cancels an in-flight loop", async () => {
    const timers = makeManualScheduler()
    const [polling] = createSignal(true)
    let reprobes = 0
    const dispose = createRoot((d) => {
      watchHarnessReprobe({
        active: () => polling(),
        reprobe: () => {
          reprobes += 1
        },
        onExhausted: () => {},
        intervalMs: 1000,
        maxAttempts: 40,
        schedule: timers.schedule,
      })
      return d
    })

    await flush()
    timers.tick()
    expect(reprobes).toBe(1)
    dispose()
    expect(timers.pendingCount()).toBe(0)
    timers.tick()
    expect(reprobes).toBe(1)
  })
})
