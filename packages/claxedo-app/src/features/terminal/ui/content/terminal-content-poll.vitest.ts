import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { startSingleFlightPoll } from "./terminal-content-policy"

const stops: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("terminal create reconciliation poll", () => {
  test("waits for completion before scheduling the next poll, and stops while pending", async () => {
    let release!: () => void
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const poll = startSingleFlightPoll(run, 10)
    stops.push(() => poll.stop())
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(9)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    poll.stop()
    release()
    await Promise.resolve()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("expires at the deadline and never re-arms after the pending request completes", async () => {
    let release!: () => void
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const onTimeout = vi.fn()
    const poll = startSingleFlightPoll(run, 10, { timeoutMs: 100, onTimeout })
    stops.push(() => poll.stop())
    await vi.advanceTimersByTimeAsync(99)
    expect(onTimeout).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await Promise.resolve()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
