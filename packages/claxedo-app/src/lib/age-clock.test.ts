/// <reference types="bun" />
import { afterEach, expect, jest, test } from "bun:test"
import { createAgeClock } from "./age-clock"
import { formatCompactAge, nextAgeChange } from "./relative-time"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

afterEach(() => {
  jest.useRealTimers()
})

test("the next age change is the instant the compact label's text changes", () => {
  const at = 1_000_000
  for (const age of [0, 59_999, 60_000, 25 * MINUTE + 3, 59 * MINUTE, HOUR, 20 * HOUR + 17, 23 * HOUR, DAY, 4 * DAY + 5]) {
    const next = nextAgeChange(at, at + age)
    expect(next).toBeGreaterThan(at + age)
    expect(formatCompactAge(at, next - 1)).toBe(formatCompactAge(at, at + age))
    expect(formatCompactAge(at, next)).not.toBe(formatCompactAge(at, at + age))
  }
})

test("past a week the change is a day away, where the palette's day count moves", () => {
  const at = 1_000_000
  const now = at + 40 * DAY + 5
  expect(nextAgeChange(at, now)).toBe(at + 41 * DAY)
})

test("an idle page with only hour-old labels wakes once, at the next hour boundary", () => {
  jest.useFakeTimers()
  const timeouts = jest.spyOn(globalThis, "setTimeout")
  const clock = createAgeClock()
  const at = Date.now() - 20 * HOUR - 17 * MINUTE
  const label = clock.watch(at)
  const shown = () => formatCompactAge(at, label.now())
  expect(shown()).toBe("20h")
  timeouts.mockClear()

  jest.advanceTimersByTime(42 * MINUTE)
  expect(timeouts).not.toHaveBeenCalled()
  expect(shown()).toBe("20h")

  jest.advanceTimersByTime(MINUTE)
  expect(shown()).toBe("21h")
  expect(timeouts).toHaveBeenCalledTimes(1)
  clock.dispose()
  timeouts.mockRestore()
})

test("one timeout serves every label, and each label's time moves only at its own boundary", () => {
  jest.useFakeTimers()
  const clock = createAgeClock()
  const fresh = clock.watch(Date.now() - 30_000)
  const old = clock.watch(Date.now() - 3 * DAY)
  const oldBefore = old.now()
  jest.advanceTimersByTime(30_000)
  expect(fresh.now()).toBe(Date.now())
  expect(old.now()).toBe(oldBefore)
  expect(jest.getTimerCount()).toBe(1)

  fresh.release()
  old.release()
  expect(jest.getTimerCount()).toBe(0)
  clock.dispose()
})

test("a hidden page schedules nothing and catches up when shown", () => {
  jest.useFakeTimers()
  const clock = createAgeClock()
  const at = Date.now() - 30_000
  const label = clock.watch(at)
  clock.pause()
  expect(jest.getTimerCount()).toBe(0)
  jest.advanceTimersByTime(5 * MINUTE)
  expect(formatCompactAge(at, label.now())).toBeUndefined()

  clock.resume()
  expect(formatCompactAge(at, label.now())).toBe("5m")
  expect(jest.getTimerCount()).toBe(1)
  clock.dispose()
})
