// RED TESTS: terminal-reattach-recovery.ts does not exist yet

import { describe, expect, test } from "bun:test"
import { createReattachRecoveryScheduler } from "./terminal-reattach-recovery"

// ---------------------------------------------------------------------------
// Fake clock + raf for deterministic testing (zero async)
// ---------------------------------------------------------------------------

function fakeClock() {
  const timers: Array<{ id: number; fn: () => void; at: number }> = []
  let now = 0
  let nextId = 1

  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++
      timers.push({ id, fn, at: now + ms })
      return id
    },
    clearTimeout(id: number) {
      const idx = timers.findIndex((t) => t.id === id)
      if (idx >= 0) timers.splice(idx, 1)
    },
    advance(ms: number) {
      const target = now + ms
      // Fire timers in chronological order
      while (true) {
        const next = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at
        const idx = timers.findIndex((t) => t.id === next.id)
        if (idx >= 0) timers.splice(idx, 1)
        next.fn()
      }
      now = target
    },
    pending: () => timers.length,
  }
}

function fakeRaf() {
  const queue: Array<{ id: number; fn: () => void }> = []
  let nextId = 1

  return {
    request(fn: () => void) {
      const id = nextId++
      queue.push({ id, fn })
      return id
    },
    cancel(id: number) {
      const idx = queue.findIndex((q) => q.id === id)
      if (idx >= 0) queue.splice(idx, 1)
    },
    flush() {
      const fns = queue.splice(0)
      for (const { fn } of fns) fn()
    },
    pending: () => queue.length,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createReattachRecoveryScheduler", () => {
  test("runs recovery immediately when no previous run", () => {
    const clock = fakeClock()
    const raf = fakeRaf()
    const calls: boolean[] = []

    const scheduler = createReattachRecoveryScheduler({
      runRecovery: (forceResize) => { calls.push(forceResize) },
      raf,
      clock,
    })

    scheduler.schedule(false)

    // No call yet — RAF has not fired
    expect(calls).toHaveLength(0)

    // Flush RAF → runRecovery fires
    raf.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(false)

    scheduler.dispose()
  })

  test("does not run twice within throttle window", () => {
    const clock = fakeClock()
    const raf = fakeRaf()
    const calls: boolean[] = []

    const scheduler = createReattachRecoveryScheduler({
      runRecovery: (forceResize) => { calls.push(forceResize) },
      raf,
      clock,
      throttleMs: 120,
    })

    // First schedule + flush → sets lastRunAt = 0
    scheduler.schedule(false)
    raf.flush()
    expect(calls).toHaveLength(1)

    // Schedule again immediately (still within throttle window)
    scheduler.schedule(false)
    raf.flush()

    // Still only 1 call — throttle suppresses second run
    expect(calls).toHaveLength(1)

    scheduler.dispose()
  })

  test("CRITICAL BUG: throttled call schedules a retry after remaining window", () => {
    // This test FAILS currently because terminal.tsx has no retry scheduling.
    // When a reattach recovery fires but is throttled, the call is simply
    // dropped. No setTimeout is enqueued to retry after the remaining window
    // expires. The terminal stays blank until something (e.g. a manual resize)
    // happens to trigger another recovery attempt.
    //
    // Expected behaviour after the fix:
    // 1. schedule(false) at t=0   → RAF fires → runRecovery called (lastRunAt=0)
    // 2. Advance clock to t=50ms  → still within 120ms throttle window
    // 3. schedule(false) at t=50  → RAF fires → throttled, but retry is scheduled
    //    for (120 - 50) = 70ms later (i.e. at t=120ms)
    // 4. Advance clock to t=130ms → retry setTimeout fires → queues new RAF
    // 5. Flush RAF                → runRecovery called a second time
    //
    // This test will FAIL on the current codebase because step 3 never schedules
    // the retry setTimeout, so runRecovery is only ever called once.

    const clock = fakeClock()
    const raf = fakeRaf()
    const calls: boolean[] = []

    const scheduler = createReattachRecoveryScheduler({
      runRecovery: (forceResize) => { calls.push(forceResize) },
      raf,
      clock,
      throttleMs: 120,
    })

    // Step 1: first run at t=0
    scheduler.schedule(false)
    raf.flush()
    expect(calls).toHaveLength(1)

    // Step 2: advance 50ms — still inside throttle window
    clock.advance(50)

    // Step 3: schedule while throttled → should enqueue a retry
    scheduler.schedule(false)
    raf.flush() // RAF fires but recovery is throttled; retry setTimeout queued

    // runRecovery not called yet (throttled)
    expect(calls).toHaveLength(1)

    // Step 4: advance past the full throttle window from the initial run
    // 50 already elapsed + 80 more = 130ms total > 120ms throttle
    clock.advance(80)

    // Step 5: the retry setTimeout should have fired, queuing a new RAF
    raf.flush()

    // Assert: runRecovery was called exactly 2 times (initial + retry)
    expect(calls).toHaveLength(2)

    scheduler.dispose()
  })

  test("multiple throttled calls coalesce into single retry", () => {
    const clock = fakeClock()
    const raf = fakeRaf()
    const calls: boolean[] = []

    const scheduler = createReattachRecoveryScheduler({
      runRecovery: (forceResize) => { calls.push(forceResize) },
      raf,
      clock,
      throttleMs: 120,
    })

    // First run at t=0
    scheduler.schedule(false)
    raf.flush()
    expect(calls).toHaveLength(1)

    // Three throttled schedules within the window
    clock.advance(30)
    scheduler.schedule(false)
    raf.flush()

    clock.advance(20)
    scheduler.schedule(false)
    raf.flush()

    clock.advance(20)
    scheduler.schedule(false)
    raf.flush()

    // Still only the 1 original call
    expect(calls).toHaveLength(1)

    // Advance past the throttle window (total elapsed: 30+20+20=70ms, need 50 more)
    clock.advance(60)
    raf.flush()

    // Exactly 1 retry — all three coalesced into a single deferred run
    expect(calls).toHaveLength(2)

    scheduler.dispose()
  })

  test("dispose cancels pending retry", () => {
    const clock = fakeClock()
    const raf = fakeRaf()
    const calls: boolean[] = []

    const scheduler = createReattachRecoveryScheduler({
      runRecovery: (forceResize) => { calls.push(forceResize) },
      raf,
      clock,
      throttleMs: 120,
    })

    // First run at t=0
    scheduler.schedule(false)
    raf.flush()
    expect(calls).toHaveLength(1)

    // Schedule while throttled → retry setTimeout is enqueued
    clock.advance(40)
    scheduler.schedule(false)
    raf.flush()

    // Dispose before the retry fires
    scheduler.dispose()

    // Advance past throttle window
    clock.advance(100)
    raf.flush()

    // runRecovery must NOT be called again after dispose
    expect(calls).toHaveLength(1)
  })

  test("forceResize=true is preserved through throttle retry", () => {
    const clock = fakeClock()
    const raf = fakeRaf()
    const calls: boolean[] = []

    const scheduler = createReattachRecoveryScheduler({
      runRecovery: (forceResize) => { calls.push(forceResize) },
      raf,
      clock,
      throttleMs: 120,
    })

    // First run at t=0 (forceResize=false)
    scheduler.schedule(false)
    raf.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(false)

    // Schedule with forceResize=true while throttled
    clock.advance(50)
    scheduler.schedule(true)
    raf.flush() // throttled — but forceResize=true must be remembered for retry

    expect(calls).toHaveLength(1)

    // Advance past throttle window
    clock.advance(80)
    raf.flush()

    // Retry must pass forceResize=true (not silently downgrade to false)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(true)

    scheduler.dispose()
  })
})
