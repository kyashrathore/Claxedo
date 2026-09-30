import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("maps commands changed and permission denied system messages", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "commands_changed",
        commands: [{ name: "review", description: "Review code", argumentHint: "<path>" }],
        uuid: "message-1",
        session_id: "session-1",
      },
    }).events).toMatchObject([{
      type: "available-commands-update",
      commands: [{ name: "review", description: "Review code" }],
    }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        message: "Command is not allowed",
        uuid: "message-2",
        session_id: "session-1",
      },
    }).events).toMatchObject([{
      type: "tool-error",
      toolCallId: "tool-1",
      error: "Command is not allowed",
    }])
  })
})
