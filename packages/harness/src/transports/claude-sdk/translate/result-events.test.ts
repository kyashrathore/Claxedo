import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("ends a user-aborted result as cancelled without a runtime error", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
      },
    }).events).toMatchObject([
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId: "sdk-session-abort" },
    ])
  })

  test("ends cancelled and interrupted error results as cancelled", () => {
    for (const error of ["Claude request cancelled by user", "Turn interrupted"]) {
      const agent = runtime()

      expect(agent.ingest({
        source: "claude.sdk.message",
        payload: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [error],
          session_id: "sdk-session-cancel",
        },
      }).events).toMatchObject([
        { type: "session-status", status: "idle" },
        { type: "cancelled", sessionId: "sdk-session-cancel" },
      ])
    }
  })
})
