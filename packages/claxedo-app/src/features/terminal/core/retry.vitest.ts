import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { retry } from "./retry"

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe("retry", () => {
  test("tries immediately, waits between failures, and stops on success", () => {
    const attempt = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
    const onDone = vi.fn()
    retry(attempt, { delay: 10, max: 5, onDone })
    expect(attempt).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(9)
    expect(attempt).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(attempt).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(10)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(onDone.mock.calls).toEqual([[true]])
    vi.runAllTimers()
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  test("reports failure exactly at the attempt limit", () => {
    const attempt = vi.fn(() => false)
    const onDone = vi.fn()
    retry(attempt, { delay: 10, max: 3, onDone })
    vi.advanceTimersByTime(19)
    expect(onDone).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(onDone.mock.calls).toEqual([[false]])
    expect(vi.getTimerCount()).toBe(0)
  })

  test("cancellation prevents future attempts and completion notification", () => {
    const attempt = vi.fn(() => false)
    const onDone = vi.fn()
    const stop = retry(attempt, { delay: 10, max: 3, onDone })
    stop()
    vi.runAllTimers()
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
