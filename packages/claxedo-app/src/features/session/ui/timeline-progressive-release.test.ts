import { describe, expect, test } from "bun:test"
import { scheduleTimelineProgressiveRelease } from "./timeline-progressive-release"

describe("scheduleTimelineProgressiveRelease", () => {
  test("does not release the full range in the first-fold reveal task", () => {
    let timer: (() => void) | undefined
    let frame: (() => void) | undefined
    let releases = 0
    const cancel = scheduleTimelineProgressiveRelease({
      sessionID: "ses_a",
      activationKey: "ses_a:1",
      currentActivationKey: () => "ses_a:1",
      release: () => releases++,
      now: 1_000,
      scheduleTimer: (callback) => {
        timer = callback
        return 1 as ReturnType<typeof setTimeout>
      },
      cancelTimer: () => {},
      scheduleFrame: (callback) => {
        frame = callback
        return 2
      },
      cancelFrame: () => {},
    })

    expect(releases).toBe(0)
    timer?.()
    expect(releases).toBe(0)
    frame?.()
    expect(releases).toBe(1)
    cancel()
  })

  test("a stale retained-session activation cannot release the new session's range", () => {
    let timer: (() => void) | undefined
    let frame: (() => void) | undefined
    let current = "ses_a:1"
    let releases = 0
    scheduleTimelineProgressiveRelease({
      activationKey: current,
      currentActivationKey: () => current,
      release: () => releases++,
      scheduleTimer: (callback) => {
        timer = callback
        return 1 as ReturnType<typeof setTimeout>
      },
      cancelTimer: () => {},
      scheduleFrame: (callback) => {
        frame = callback
        return 2
      },
      cancelFrame: () => {},
    })

    timer?.()
    current = "ses_b:1"
    frame?.()
    expect(releases).toBe(0)
  })
})
