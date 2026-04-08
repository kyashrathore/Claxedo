import { describe, expect, test } from "bun:test"
import { timelineWorking } from "./message-timeline-state"

describe("timelineWorking", () => {
  test("hides the spinner when an unfinished message is stale but session is idle", () => {
    expect(
      timelineWorking({
        pending: true,
        blocked: false,
        status: { type: "idle" },
      }),
    ).toBe(false)
  })

  test("keeps the spinner while pending output has no authoritative session status yet", () => {
    expect(
      timelineWorking({
        pending: true,
        blocked: false,
        status: undefined,
      }),
    ).toBe(true)
  })

  test("treats blocked busy sessions as waiting instead of streaming", () => {
    expect(
      timelineWorking({
        pending: false,
        blocked: true,
        status: { type: "busy" },
      }),
    ).toBe(false)
  })

  test("shows the spinner for true non-blocked busy sessions", () => {
    expect(
      timelineWorking({
        pending: false,
        blocked: false,
        status: { type: "busy" },
      }),
    ).toBe(true)
  })

  test("does not show the spinner for recovering sessions", () => {
    expect(
      timelineWorking({
        pending: false,
        blocked: false,
        status: {
          type: "recovering",
          kind: "process_restart",
          message: "Recovering ACP client...",
        },
      }),
    ).toBe(false)
  })

  test("keeps the spinner when output is still pending and status is busy", () => {
    expect(
      timelineWorking({
        pending: true,
        blocked: true,
        status: { type: "busy" },
      }),
    ).toBe(true)
  })
})
