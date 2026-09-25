/// <reference types="bun" />
import { afterEach, expect, jest, test } from "bun:test"
import { createSecondTicker, SECOND_TICK_MS } from "./second-ticker"

afterEach(() => {
  jest.useRealTimers()
})

test("the 1 s tick runs only while a reader holds it, and one interval serves every reader", () => {
  jest.useFakeTimers()
  const intervals = jest.spyOn(globalThis, "setInterval")
  const ticker = createSecondTicker()
  jest.advanceTimersByTime(5 * SECOND_TICK_MS)
  expect(intervals).not.toHaveBeenCalled()

  const releaseTool = ticker.subscribe()
  const releaseRetry = ticker.subscribe()
  expect(intervals).toHaveBeenCalledTimes(1)
  const started = ticker.second()
  jest.advanceTimersByTime(3 * SECOND_TICK_MS)
  expect(ticker.second() - started).toBe(3 * SECOND_TICK_MS)

  releaseTool()
  releaseTool()
  jest.advanceTimersByTime(SECOND_TICK_MS)
  expect(ticker.second() - started).toBe(4 * SECOND_TICK_MS)

  releaseRetry()
  const stopped = ticker.second()
  jest.advanceTimersByTime(5 * SECOND_TICK_MS)
  expect(ticker.second()).toBe(stopped)

  ticker.subscribe()
  expect(intervals).toHaveBeenCalledTimes(2)
  expect(ticker.second()).toBe(Date.now())
  ticker.dispose()
  intervals.mockRestore()
})
