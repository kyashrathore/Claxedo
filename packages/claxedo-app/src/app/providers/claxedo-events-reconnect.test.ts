import { describe, expect, it } from "bun:test"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-event-runtime"
import {
  HEARTBEAT_TIMEOUT_MS,
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
    // failures=1 → ceiling 500 → [250, 500]
    expect(reconnectBackoffMs(1, () => 0)).toBe(250)
    expect(reconnectBackoffMs(1, () => 1)).toBe(500)
    expect(reconnectBackoffMs(1, () => 0.5)).toBe(375)
    // failures=2 → ceiling 1000 → [500, 1000]
    expect(reconnectBackoffMs(2, () => 0)).toBe(500)
    expect(reconnectBackoffMs(2, () => 1)).toBe(1000)
  })

  it("never exceeds the 15s ceiling regardless of failure count", () => {
    expect(reconnectBackoffMs(100, () => 1)).toBe(MAX_RECONNECT_DELAY_MS)
    expect(reconnectBackoffMs(100, () => 0)).toBe(MAX_RECONNECT_DELAY_MS / 2)
  })
})

describe("reconnectDelayMs", () => {
  it("floors the backoff by the fast-session-switch quiet window", () => {
    // backoff for failures=0 is 250; a 5000ms quiet window wins.
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

describe("HEARTBEAT_TIMEOUT_MS", () => {
  it("waits for more than one producer heartbeat before calling a stream stalled", () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBeGreaterThan(EVENT_STREAM_HEARTBEAT_MS)
  })
})
