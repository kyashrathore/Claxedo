import { createRoot, createSignal, flush } from "solid-js"
import { expect, test } from "bun:test"
import { createTimelineWorkingStatus } from "./timeline-working-status"

// Solid 2 rejects reactive writes from inside an owned scope, so the driving
// signals live outside `createRoot` and only the status graph is built inside
// it; and writes stage until `flush()`, so every assertion that follows a write
// flushes first. `status()` itself is a memo, so the reads need no flush of
// their own — the flush is what lets the latching effects observe the write.
type PendingTimer = { task: () => void; cancelled: boolean }

function scheduleInto(pending: PendingTimer[]) {
  return (task: () => void) => {
    const timer: PendingTimer = { task, cancelled: false }
    pending.push(timer)
    return () => {
      timer.cancelled = true
    }
  }
}

test("a hidden pane neither starts nor completes working-indicator timers", () => {
  const [active, setActive] = createSignal(true)
  const [working, setWorking] = createSignal(false)
  const pending: PendingTimer[] = []
  const root = createRoot((dispose) => ({
    dispose,
    status: createTimelineWorkingStatus({ active, working, schedule: scheduleInto(pending) }),
  }))
  const status = root.status
  // The initial flush is what the Solid 1 `createComputed` got for free: it runs
  // the latch's effect phase once against the mounted state, so the next run's
  // `previous` carries the working flag the pane mounted with.
  flush()

  expect(status()).toBe("hidden")
  setWorking(true)
  flush()
  expect(status()).toBe("showing")
  setActive(false)
  setWorking(false)
  flush()
  expect(status()).toBe("showing")
  expect(pending).toHaveLength(0)

  setActive(true)
  flush()
  expect(status()).toBe("hiding")
  expect(pending).toHaveLength(1)

  pending[0].task()
  flush()
  expect(status()).toBe("hidden")
  root.dispose()
})

test("hiding cancels an already armed pane timer and rearms once on activation", () => {
  const [active, setActive] = createSignal(true)
  const [working, setWorking] = createSignal(true)
  const pending: PendingTimer[] = []
  const root = createRoot((dispose) => ({
    dispose,
    status: createTimelineWorkingStatus({ active, working, schedule: scheduleInto(pending) }),
  }))
  const status = root.status
  // See above: settle the mounted state so the latch has a `previous` to compare
  // the first working -> idle transition against.
  flush()

  expect(status()).toBe("showing")
  setWorking(false)
  flush()
  expect(status()).toBe("hiding")
  expect(pending).toHaveLength(1)

  setActive(false)
  flush()
  expect(pending[0].cancelled).toBe(true)
  setWorking(true)
  setWorking(false)
  flush()
  expect(pending).toHaveLength(1)

  setActive(true)
  flush()
  expect(pending).toHaveLength(2)
  pending[1].task()
  flush()
  expect(status()).toBe("hidden")
  root.dispose()
})
