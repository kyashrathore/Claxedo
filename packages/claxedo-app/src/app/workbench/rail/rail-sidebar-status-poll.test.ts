import { describe, expect, test } from "bun:test"
import { createSidebarStatusPoll } from "./rail-sidebar-status-poll"

/** Minimal deterministic clock: no real timers, so ordering is exact. */
function fakeClock() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    schedule(fn: () => void, ms: number) {
      const id = nextId++
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clear(timer: unknown) {
      pending.delete(timer as number)
    },
    advance(ms: number) {
      const target = now + ms
      // Fire in due order, allowing a callback to schedule its successor.
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
    get pendingCount() {
      return pending.size
    },
  }
}

describe("createSidebarStatusPoll", () => {
  test("runs the batch once after the initial delay", () => {
    const clock = fakeClock()
    let runs = 0
    const poll = createSidebarStatusPoll({
      run: () => {
        runs++
      },
      schedule: clock.schedule,
      clear: clock.clear,
    })
    poll.start()

    expect(runs).toBe(0)
    clock.advance(250)
    expect(runs).toBe(1)
  })

  // The actual v0.0.65 defect: `run` was scheduled once and never rescheduled,
  // so a session that went busy after that single fetch never showed activity.
  test("keeps running on an interval instead of stopping after the first fetch", () => {
    const clock = fakeClock()
    let runs = 0
    const poll = createSidebarStatusPoll({
      run: () => {
        runs++
      },
      schedule: clock.schedule,
      clear: clock.clear,
    })
    poll.start()

    clock.advance(250)
    expect(runs).toBe(1)
    clock.advance(5_000)
    expect(runs).toBe(2)
    clock.advance(15_000)
    expect(runs).toBe(5)
  })

  test("polls faster than the rail's freshness window so rows never render aged-out status", () => {
    const clock = fakeClock()
    let runs = 0
    const poll = createSidebarStatusPoll({
      run: () => {
        runs++
      },
      schedule: clock.schedule,
      clear: clock.clear,
    })
    poll.start()
    clock.advance(250)
    const before = runs
    // SIDEBAR_SESSION_STATUS_FRESH_MS is 10_000.
    clock.advance(10_000)
    expect(runs).toBeGreaterThan(before)
  })

  test("skips a tick while the gate is closed but keeps the loop alive", () => {
    const clock = fakeClock()
    let runs = 0
    let open = false
    const poll = createSidebarStatusPoll({
      run: () => {
        runs++
      },
      schedule: clock.schedule,
      clear: clock.clear,
      shouldRun: () => open,
    })
    poll.start()

    clock.advance(250)
    expect(runs).toBe(0)
    clock.advance(10_000)
    expect(runs).toBe(0)

    // Reopening must resume without a restart — a loop that died on the closed
    // gate would leave the rail permanently stale.
    open = true
    clock.advance(5_000)
    expect(runs).toBeGreaterThan(0)
  })

  test("stop halts the loop and leaves no timer armed", () => {
    const clock = fakeClock()
    let runs = 0
    const poll = createSidebarStatusPoll({
      run: () => {
        runs++
      },
      schedule: clock.schedule,
      clear: clock.clear,
    })
    poll.start()
    clock.advance(250)
    expect(runs).toBe(1)

    poll.stop()
    clock.advance(60_000)
    expect(runs).toBe(1)
    expect(clock.pendingCount).toBe(0)
  })

  test("start is idempotent — a second start does not double the cadence", () => {
    const clock = fakeClock()
    let runs = 0
    const poll = createSidebarStatusPoll({
      run: () => {
        runs++
      },
      schedule: clock.schedule,
      clear: clock.clear,
    })
    poll.start()
    poll.start()

    clock.advance(250)
    expect(runs).toBe(1)
    clock.advance(5_000)
    expect(runs).toBe(2)
  })
})
