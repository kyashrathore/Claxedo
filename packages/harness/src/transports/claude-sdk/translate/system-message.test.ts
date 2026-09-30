import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("maps system init slash commands and reports unmapped init metadata", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "init",
        cwd: "/repo",
        tools: ["Read", "Edit"],
        slash_commands: ["review", "compact"],
        model: "claude-sonnet",
        permissionMode: "default",
        output_style: "default",
      },
    }).events).toMatchObject([
      {
        type: "available-commands-update",
        commands: [
          { name: "review", description: "review" },
          { name: "compact", description: "compact" },
        ],
      },
      {
        type: "diagnostic",
        diagnostic: {
          code: "claude_sdk.unmapped_event",
          severity: "info",
          details: { sdkEvent: "SDKSystemMessage(init)" },
        },
      },
    ])
  })

  test("a post-turn summary is an informational diagnostic, never an adapter error", () => {
    const agent = runtime()
    const summarised = agent.ingest({
      source: "claude.sdk.message",
      payload: { type: "system", subtype: "post_turn_summary", summary: "Counted to thirty.", uuid: "message-9", session_id: "session-1" },
    }).events
    expect(summarised).toMatchObject([{ type: "diagnostic", diagnostic: { code: "claude_sdk.post_turn_summary", severity: "info", message: "Counted to thirty." } }])
    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: { type: "system", subtype: "post_turn_summary", uuid: "message-10", session_id: "session-1" },
    }).events).toEqual([])
  })

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
