import { describe, expect, test } from "bun:test"
import {
  isDefinitiveTerminalCreateFailure,
  pickAdoptedPty,
  shouldMountTerminalPane,
  startSingleFlightPoll,
} from "./terminal-content-policy"

describe("terminal content mount policy", () => {
  test("keeps never-activated hidden terminal panes from reconnecting on reload", () => {
    expect(shouldMountTerminalPane({ visible: false, ptyReady: true, activated: false })).toBe(false)
  })

  test("waits for activation before mounting so pending→real route settle cannot drop the socket", () => {
    expect(shouldMountTerminalPane({ visible: true, ptyReady: true, activated: false })).toBe(false)
    expect(shouldMountTerminalPane({ visible: true, ptyReady: true, activated: true })).toBe(true)
    expect(shouldMountTerminalPane({ visible: true, ptyReady: false, activated: true })).toBe(false)
  })

  test("keeps activated live terminal panes mounted while hidden for fast switching", () => {
    expect(shouldMountTerminalPane({ visible: false, ptyReady: true, activated: true })).toBe(true)
  })
})

describe("pickAdoptedPty", () => {
  test("adopts only the pty carrying the originating create request id", () => {
    expect(pickAdoptedPty(
      [
        { id: "pty_a", sessionId: "ses_a", createRequestId: "request-a" },
        { id: "pty_b", sessionId: "ses_a", createRequestId: "request-b" },
      ],
      "request-a",
    )?.id).toBe("pty_a")
  })

  test("refuses duplicate correlations instead of guessing", () => {
    expect(pickAdoptedPty(
      [
        { id: "pty_a", createRequestId: "request-a" },
        { id: "pty_b", createRequestId: "request-a" },
      ],
      "request-a",
    )).toBeUndefined()
  })

  test("never adopts a sole new pty without an exact correlation", () => {
    expect(pickAdoptedPty(
      [{ id: "pty_a", sessionId: "ses_a" }],
      "request-a",
    )).toBeUndefined()
  })

  test("keeps two clients in one session bound to their own create", () => {
    expect(pickAdoptedPty(
      [
        { id: "pty_client_a", sessionId: "ses_shared", createRequestId: "request-a" },
        { id: "pty_client_b", sessionId: "ses_shared", createRequestId: "request-b" },
      ],
      "request-b",
    )?.id).toBe("pty_client_b")
  })
})

describe("startSingleFlightPoll", () => {
  test("does not overlap polls and stops scheduling after disposal", async () => {
    let calls = 0
    let active = 0
    let maximumActive = 0
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const poller = startSingleFlightPoll(async () => {
      calls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (calls === 1) await first
      active -= 1
    }, 1)

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(1)
    expect(maximumActive).toBe(1)

    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBeGreaterThan(1)
    expect(maximumActive).toBe(1)

    poller.stop()
    const stoppedAt = calls
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(stoppedAt)
  })

  test("stops a stalled reconciliation at its deadline", async () => {
    let calls = 0
    let timedOut = 0
    startSingleFlightPoll(async () => {
      calls += 1
      await new Promise<void>(() => {})
    }, 1, {
      timeoutMs: 10,
      onTimeout: () => {
        timedOut += 1
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(1)
    expect(timedOut).toBe(1)
  })
})

describe("pending terminal create failure policy", () => {
  test("ends reconciliation only for an authoritative non-retryable client failure", () => {
    expect(isDefinitiveTerminalCreateFailure(Object.assign(new Error("denied"), { status: 403 }))).toBe(true)
    expect(isDefinitiveTerminalCreateFailure(Object.assign(new Error("timeout"), { status: 408 }))).toBe(false)
    expect(isDefinitiveTerminalCreateFailure(Object.assign(new Error("overloaded"), { status: 503 }))).toBe(false)
    expect(isDefinitiveTerminalCreateFailure(new TypeError("network unavailable"))).toBe(false)
  })
})
