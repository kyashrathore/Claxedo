import { beforeEach, describe, expect, test, vi } from "bun:test"
import { scheduleAttach, MAX_CONCURRENT_ATTACHES, _resetForTesting } from "./attach-scheduler"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fills MAX_CONCURRENT_ATTACHES slots with long-running tasks and returns
 * an array of done() callbacks so the caller can release slots individually.
 */
function fillSlots(): Array<() => void> {
  const dones: Array<() => void> = []
  for (let i = 0; i < MAX_CONCURRENT_ATTACHES; i++) {
    scheduleAttach({
      paneId: `filler-${i}`,
      run(done) {
        dones.push(done)
      },
    })
  }
  return dones
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attach scheduler", () => {
  beforeEach(() => _resetForTesting())

  test("MAX_CONCURRENT_ATTACHES is 3", () => {
    expect(MAX_CONCURRENT_ATTACHES).toBe(3)
  })

  test("runs tasks immediately when under limit", () => {
    const run = vi.fn((_done: () => void) => {})
    scheduleAttach({ paneId: "pane-a", run })
    // A slot is available — run() must have been called synchronously
    expect(run).toHaveBeenCalledTimes(1)
  })

  test("queues 4th task when 3 are in-flight", () => {
    // Occupy all MAX_CONCURRENT_ATTACHES slots, holding done() for each
    const dones = fillSlots()

    // Schedule a 4th task — all slots are full, so it must queue
    const run4 = vi.fn((_done: () => void) => {})
    scheduleAttach({ paneId: "pane-overflow", run: run4 })

    expect(run4).toHaveBeenCalledTimes(0)

    // Release one slot — the queued task should now start
    dones[0]()

    expect(run4).toHaveBeenCalledTimes(1)
  })

  test("deduplicates: new task for same paneId cancels previous pending task", () => {
    // Fill all slots so the next tasks land in the queue, not in-flight
    const dones = fillSlots()

    const runFirst = vi.fn((_done: () => void) => {})
    const runSecond = vi.fn((_done: () => void) => {})

    // Both schedule calls queue (no slots free)
    scheduleAttach({ paneId: "pane-x", run: runFirst })
    // Second schedule for the same paneId should supersede the first
    scheduleAttach({ paneId: "pane-x", run: runSecond })

    // Release all filler slots — only runSecond should ever execute
    for (const done of dones) done()

    expect(runFirst).toHaveBeenCalledTimes(0)
    expect(runSecond).toHaveBeenCalledTimes(1)
  })

  test("cancel() before run prevents execution", () => {
    // Fill slots so the next task sits in the queue
    const dones = fillSlots()

    const run = vi.fn((_done: () => void) => {})
    const cancel = scheduleAttach({ paneId: "pane-cancel", run })

    // Cancel while task is still pending (not yet running)
    cancel()

    // Release all filler slots
    for (const done of dones) done()

    // The cancelled task must never have started
    expect(run).toHaveBeenCalledTimes(0)
  })

  test("calling done() twice does not double-decrement in-flight count", () => {
    const dones: Array<() => void> = []

    // Fill exactly MAX_CONCURRENT_ATTACHES slots; collect done() for each
    for (let i = 0; i < MAX_CONCURRENT_ATTACHES; i++) {
      scheduleAttach({
        paneId: `pane-${i}`,
        run(done) {
          dones.push(done)
        },
      })
    }

    // Queue one extra task — all slots are occupied
    const runExtra = vi.fn((_done: () => void) => {})
    scheduleAttach({ paneId: "pane-extra", run: runExtra })
    expect(runExtra).toHaveBeenCalledTimes(0)

    // First task calls done() twice (buggy consumer)
    dones[0]()
    dones[0]()

    // Only one slot was legitimately freed — runExtra should start exactly once
    expect(runExtra).toHaveBeenCalledTimes(1)

    // The scheduler must not have over-decremented: schedule another task and
    // confirm it is still queued (3 slots filled: pane-1, pane-2, pane-extra)
    const runExtra2 = vi.fn((_done: () => void) => {})
    scheduleAttach({ paneId: "pane-extra2", run: runExtra2 })
    expect(runExtra2).toHaveBeenCalledTimes(0)
  })

  test("cancel() on an in-flight task calls done idempotently", () => {
    // Schedule a single task — it starts immediately (one slot is free)
    let capturedDone: (() => void) | undefined
    const cancel = scheduleAttach({
      paneId: "pane-inflight",
      run(done) {
        capturedDone = done
      },
    })

    // Confirm the task is in-flight
    expect(capturedDone).toBeDefined()

    // Fill the remaining slots so subsequent tasks will queue
    const extraDones = fillSlots()

    // Queue a follower that should start once a slot frees
    const runFollower = vi.fn((_done: () => void) => {})
    scheduleAttach({ paneId: "pane-follower", run: runFollower })
    expect(runFollower).toHaveBeenCalledTimes(0)

    // Cancel the in-flight task — the scheduler must internally call done(),
    // freeing the slot without requiring a second explicit done() call
    cancel()

    // Release the extra filler slots
    for (const done of extraDones) done()

    // The follower should now have run
    expect(runFollower).toHaveBeenCalledTimes(1)
  })
})
