import { describe, expect, it } from "bun:test"
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

// A deterministic fake clock drives the provider's documented reconnect loop
// (scheduleReconnect: delay = reconnectDelayMs(failures); failures += 1) so the
// timing machine is specced without a live SSE connection.
describe("reconnect machine (fake clock)", () => {
  type Timer = { at: number; fire: () => void }

  function harness() {
    const log: Array<{ event: string; failures: number; delay?: number; escalation?: string }> = []
    let now = 0
    let pending: Timer | null = null
    const state = { failures: 0, reconnectArmed: false, heartbeatArmed: false }

    const scheduleReconnect = () => {
      if (state.reconnectArmed) return
      const delay = reconnectDelayMs(state.failures, 0, () => 0) // deterministic min-of-window
      log.push({
        event: "schedule-reconnect",
        failures: state.failures,
        delay,
        escalation: failureEscalation(state.failures),
      })
      state.failures += 1
      state.reconnectArmed = true
      state.heartbeatArmed = false
      pending = {
        at: now + delay,
        fire: () => {
          state.reconnectArmed = false
          connect()
        },
      }
    }

    const connect = () => {
      log.push({ event: "connect", failures: state.failures })
    }

    // Simulate a stream that opens successfully: resets failures, arms heartbeat.
    const open = () => {
      state.failures = 0
      state.heartbeatArmed = true
      state.reconnectArmed = false
      pending = { at: now + HEARTBEAT_TIMEOUT_MS, fire: () => heartbeatTimeout() }
      log.push({ event: "open", failures: state.failures })
    }

    // Heartbeat timeout tears down and schedules a reconnect.
    const heartbeatTimeout = () => {
      log.push({ event: "heartbeat-timeout", failures: state.failures })
      state.heartbeatArmed = false
      scheduleReconnect()
    }

    const fail = () => scheduleReconnect()

    const advanceTo = (t: number) => {
      now = t
      while (pending && pending.at <= now) {
        const timer = pending
        pending = null
        timer.fire()
      }
    }

    return {
      log,
      state,
      fail,
      open,
      advanceTo,
      get now() {
        return now
      },
    }
  }

  it("schedules a reconnect after a heartbeat timeout and reconnects when it fires", () => {
    const h = harness()
    h.open()
    // Advance past the heartbeat window: the timeout fires → schedule-reconnect.
    h.advanceTo(HEARTBEAT_TIMEOUT_MS)
    expect(h.log.map((entry) => entry.event)).toEqual(["open", "heartbeat-timeout", "schedule-reconnect"])
    const scheduled = h.log.find((entry) => entry.event === "schedule-reconnect")!
    expect(scheduled.delay).toBe(RECONNECT_DELAY_MS) // first failure of the run
    // Advance past the reconnect delay → connect() fires.
    h.advanceTo(HEARTBEAT_TIMEOUT_MS + RECONNECT_DELAY_MS)
    expect(h.log.at(-1)!.event).toBe("connect")
  })

  it("backs off across a sustained failure run and escalates exactly once", () => {
    const h = harness()
    // 5 consecutive failures with no successful open between them.
    for (let i = 0; i < 5; i++) {
      h.fail()
      h.advanceTo(h.now + MAX_RECONNECT_DELAY_MS) // let each reconnect fire
    }
    const escalations = h.log.filter((entry) => entry.event === "schedule-reconnect").map((entry) => entry.escalation)
    // failures 0,1,2 quiet; 3 escalate; 4 silent — escalate appears exactly once.
    expect(escalations).toEqual(["quiet", "quiet", "quiet", "escalate", "silent"])
    expect(escalations.filter((value) => value === "escalate")).toHaveLength(1)
  })

  it("resets the failure counter on a successful reopen so a later run escalates again", () => {
    const h = harness()
    h.fail() // failures 0 → schedules with failures=0, counter now 1
    h.fail() // reconnectArmed true → ignored (mirrors the single-timer guard)
    h.open() // success resets failures to 0
    const afterOpen = h.log.filter((entry) => entry.event === "schedule-reconnect")
    expect(afterOpen).toHaveLength(1)
    expect(h.state.failures).toBe(0)
  })
})
