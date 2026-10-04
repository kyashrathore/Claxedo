import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("a Bash result's leading exit code travels on the completion, error or not", () => {
    const agent = runtime()
    const events = (id: string, name: string, content: string, isError: boolean) => {
      agent.ingest({ source: "claude.sdk.message", payload: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { command: "grep needle haystack" } }] } } })
      return agent.ingest({ source: "claude.sdk.message", payload: {
        type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
      } }).events.filter((event) => event.type === "tool-output" || event.type === "tool-error")
    }
    expect(events("bash-no-match", "Bash", "Exit code 1\n", false))
      .toMatchObject([{ type: "tool-output", toolCallId: "bash-no-match", metadata: { exitCode: 1 } }])
    expect(events("bash-crash", "Bash", "Exit code 127\nzsh: command not found: grep", true))
      .toMatchObject([{ type: "tool-error", toolCallId: "bash-crash", metadata: { exitCode: 127 } }])
    expect(events("bash-ok", "Bash", "needle", false)[0]?.metadata).not.toHaveProperty("exitCode")
    expect(events("read-1", "Read", "Exit code 1 appears in this file", false)[0]?.metadata).not.toHaveProperty("exitCode")
  })

  test("projects native task results and keeps task IDs across the turn", () => {
    const agent = runtime()
    const call = (id: string, name: string, input: unknown, result: unknown, isError = false) => {
      agent.ingest({ source: "claude.sdk.message", payload: {
        type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] },
      } })
      return agent.ingest({ source: "claude.sdk.message", payload: {
        type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "native result", is_error: isError }] },
        tool_use_result: result,
      } }).events.filter((event) => event.type === "todo-update")
    }
    expect(call("create", "TaskCreate", { subject: "Inspect" }, { task: { id: "42", subject: "Inspect" } }))
      .toMatchObject([{ type: "todo-update", todos: [{ id: "42", description: "Inspect", status: "pending" }] }])
    expect(call("denied", "TaskUpdate", { taskId: "42", status: "completed" }, { success: false, taskId: "42" }))
      .toEqual([])
    expect(call("error", "TaskUpdate", { taskId: "42", status: "completed" }, { success: true, taskId: "42", statusChange: { to: "completed" } }, true))
      .toEqual([])
    expect(call("update", "TaskUpdate", { taskId: "42", status: "completed" }, { success: true, taskId: "42", updatedFields: ["status"], statusChange: { from: "pending", to: "in_progress" } }))
      .toMatchObject([{ type: "todo-update", todos: [{ id: "42", status: "in_progress" }] }])
    expect(call("delete", "TaskUpdate", { taskId: "42", status: "deleted" }, { success: true, taskId: "42", updatedFields: ["status"], statusChange: { from: "in_progress", to: "deleted" } }))
      .toMatchObject([{ type: "todo-update", todos: [] }])
    expect(call("list", "TaskList", {}, { tasks: [{ id: "99", subject: "Ship", status: "completed" }] }))
      .toMatchObject([{ type: "todo-update", todos: [{ id: "99", description: "Ship", status: "completed" }] }])
  })

  test("U2: emits flattened text for array-content Claude tool results", () => {
    const agent = runtime()
    agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-grep-array-1", name: "Grep", input: {} },
        },
      },
    })

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-grep-array-1",
            content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
          }],
        },
      },
    }).events).toMatchObject([{
      type: "tool-output",
      toolCallId: "tool-grep-array-1",
      output: "first\nsecond",
    }])
  })

  test("leaves a text-only read result without attachments", () => {
    const agent = runtime()
    agent.ingest({
      source: "claude.sdk.message",
      payload: { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-read-text-1", name: "Read", input: { file_path: "/repo/src/index.ts" } }] } },
    })
    const events = agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-read-text-1", content: "     1\texport const a = 1" }] },
      },
    }).events
    expect(events).toMatchObject([{ type: "tool-output", toolCallId: "tool-read-text-1", output: "     1\texport const a = 1" }])
    expect(events[0]).not.toHaveProperty("attachments")
  })

  test("U5: registers complete Agent tool blocks and renders the structured result", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        uuid: "assistant-agent-1",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        message: {
          content: [{
            type: "tool_use",
            id: "tool-agent-complete-1",
            name: "Agent",
            input: { description: "Review auth", subagent_type: "code-reviewer" },
          }],
        },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-agent-complete-1", toolName: "Agent" },
      { type: "tool-input", toolCallId: "tool-agent-complete-1" },
    ])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "user",
        uuid: "user-agent-1",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-agent-complete-1",
            content: [{ type: "text", text: "model-directed trailer" }],
          }],
        },
        tool_use_result: {
          status: "completed",
          agentId: "agent-42",
          content: [{ type: "text", text: "Found one issue" }],
          totalTokens: 321,
          totalToolUseCount: 4,
          totalDurationMs: 900,
          usage: { input_tokens: 250, output_tokens: 71 },
          toolStats: { readCount: 2, searchCount: 1 },
        },
      },
    }).events).toMatchObject([{
      type: "tool-output",
      toolCallId: "tool-agent-complete-1",
      output: "Found one issue",
      metadata: {
        claude: {
          subagent: {
            agentId: "agent-42",
            totalTokens: 321,
            totalToolUseCount: 4,
            totalDurationMs: 900,
            toolStats: { readCount: 2, searchCount: 1 },
          },
        },
      },
    }])
  })
})
