import { describe, expect, test } from "bun:test"
import { MAX_RECONNECT_DELAY_MS, RECONNECT_DELAY_MS, reconnectBackoffMs } from "./reconnect-backoff"

describe("reconnectBackoffMs", () => {
  test("first retry (0 prior failures) uses the base delay with no jitter", () => {
    expect(reconnectBackoffMs(0, () => 0.5)).toBe(RECONNECT_DELAY_MS)
  })

  test("grows exponentially: the low-jitter floor doubles each consecutive failure", () => {
    // random()=0 → result is exactly ceiling/2 = base * 2^failures / 2
    expect(reconnectBackoffMs(1, () => 0)).toBe(250)
    expect(reconnectBackoffMs(2, () => 0)).toBe(500)
    expect(reconnectBackoffMs(3, () => 0)).toBe(1000)
  })

  test("jitter adds up to half the ceiling on top of the floor", () => {
    // failures=2 → ceiling=1000, floor=500, +random*500
    expect(reconnectBackoffMs(2, () => 1)).toBe(1000)
    expect(reconnectBackoffMs(2, () => 0.5)).toBe(750)
  })

  test("never exceeds the max reconnect delay window", () => {
    const value = reconnectBackoffMs(100, () => 1)
    expect(value).toBe(MAX_RECONNECT_DELAY_MS)
    expect(value).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS)
  })
})
