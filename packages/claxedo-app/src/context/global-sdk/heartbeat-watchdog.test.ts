import { describe, expect, test } from "bun:test"
import { createHeartbeatWatchdog } from "./heartbeat-watchdog"

/** Deterministic single-slot fake timer + clock. */
function harness() {
  let clock = 0
  let pending: { fn: () => void; at: number } | undefined
  return {
    watchdog(timeoutMs: number, onTimeout: () => void) {
      return createHeartbeatWatchdog({
        timeoutMs,
        onTimeout,
        now: () => clock,
        setTimer: (fn, ms) => {
          pending = { fn, at: clock + ms }
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: () => {
          pending = undefined
        },
      })
    },
    advance(ms: number) {
      clock += ms
      if (pending && clock >= pending.at) {
        const fn = pending.fn
        pending = undefined
        fn()
      }
    },
    hasTimer: () => pending !== undefined,
  }
}

describe("createHeartbeatWatchdog", () => {
  test("fires onTimeout when no reset arrives within the timeout window", () => {
    const h = harness()
    let fired = 0
    const w = h.watchdog(15_000, () => {
      fired++
    })
    w.reset()
    h.advance(15_000)
    expect(fired).toBe(1)
  })

  test("a reset before the deadline reschedules and prevents the timeout", () => {
    const h = harness()
    let fired = 0
    const w = h.watchdog(15_000, () => {
      fired++
    })
    w.reset()
    h.advance(10_000)
    w.reset() // restart the window
    h.advance(10_000) // 20_000 total, but only 10_000 since last reset
    expect(fired).toBe(0)
    h.advance(5_000) // now 15_000 since last reset
    expect(fired).toBe(1)
  })

  test("clear cancels the pending timeout so it never fires", () => {
    const h = harness()
    let fired = 0
    const w = h.watchdog(15_000, () => {
      fired++
    })
    w.reset()
    w.clear()
    expect(h.hasTimer()).toBe(false)
    h.advance(15_000)
    expect(fired).toBe(0)
  })

  test("sinceLastEvent tracks elapsed time and touch refreshes it without arming a timer", () => {
    const h = harness()
    const w = h.watchdog(15_000, () => {})
    h.advance(5_000)
    expect(w.sinceLastEvent()).toBe(5_000)
    w.touch()
    expect(w.sinceLastEvent()).toBe(0)
    expect(h.hasTimer()).toBe(false) // touch does not schedule
  })
})
