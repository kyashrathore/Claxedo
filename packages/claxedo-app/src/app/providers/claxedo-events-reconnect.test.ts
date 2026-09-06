import { describe, expect, it } from "bun:test"
import {
  MAX_RECONNECT_DELAY_MS,
  RECONNECT_DELAY_MS,
  SUSTAINED_FAILURE_THRESHOLD,
  failureEscalation,
  reconnectBackoffMs,
  reconnectDelayMs,
} from "./claxedo-events-reconnect"

describe("reconnectBackoffMs", () => {
  it("uses the base delay for the first retry", () => {
    expect(reconnectBackoffMs(0, () => 0.5)).toBe(RECONNECT_DELAY_MS)
    expect(reconnectBackoffMs(-1, () => 0.5)).toBe(RECONNECT_DELAY_MS)
  })

  it("grows exponentially, jittering within the top half of the window", () => {
    // failures=1 → ceiling 4000 → [2000, 4000]
    expect(reconnectBackoffMs(1, () => 0)).toBe(2000)
    expect(reconnectBackoffMs(1, () => 1)).toBe(4000)
    expect(reconnectBackoffMs(1, () => 0.5)).toBe(3000)
    // failures=2 → ceiling 8000 → [4000, 8000]
    expect(reconnectBackoffMs(2, () => 0)).toBe(4000)
    expect(reconnectBackoffMs(2, () => 1)).toBe(8000)
  })

  it("never exceeds the 30s ceiling regardless of failure count", () => {
    expect(reconnectBackoffMs(100, () => 1)).toBe(MAX_RECONNECT_DELAY_MS)
    expect(reconnectBackoffMs(100, () => 0)).toBe(MAX_RECONNECT_DELAY_MS / 2)
  })
})

describe("reconnectDelayMs", () => {
  it("floors the backoff by the fast-session-switch quiet window", () => {
    // backoff for failures=0 is 2000; a 5000ms quiet window wins.
    expect(reconnectDelayMs(0, 5000, () => 0.5)).toBe(5000)
    // no quiet window → plain backoff.
    expect(reconnectDelayMs(0, 0, () => 0.5)).toBe(RECONNECT_DELAY_MS)
  })
})

describe("failureEscalation", () => {
  it("stays quiet before the sustained threshold", () => {
    expect(failureEscalation(0)).toBe("quiet")
    expect(failureEscalation(SUSTAINED_FAILURE_THRESHOLD - 1)).toBe("quiet")
  })

  it("escalates exactly at the threshold, then goes silent", () => {
    expect(failureEscalation(SUSTAINED_FAILURE_THRESHOLD)).toBe("escalate")
    expect(failureEscalation(SUSTAINED_FAILURE_THRESHOLD + 1)).toBe("silent")
    expect(failureEscalation(SUSTAINED_FAILURE_THRESHOLD + 5)).toBe("silent")
  })
})
