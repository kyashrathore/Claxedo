import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import type { RuntimeSnapshot } from "../../core/state"
import { claudeSdkAdapter, type ClaudeSdkAdapterState } from "./adapter"

function runtime(initialSnapshot?: RuntimeSnapshot<ClaudeSdkAdapterState>) {
  return createAgentEventRuntime({
    harness: "claude-sdk",
    threadId: "thread-1",
    adapter: claudeSdkAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
    ...(initialSnapshot ? { initialSnapshot } : {}),
  })
}

describe("claudeSdkAdapter", () => {
  test("maps text deltas and suppresses duplicate assistant snapshots", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: "Hi" }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        uuid: "assistant-1",
        message: { id: "message-1", content: [{ type: "text", text: "Hi" }] },
      },
    }).events).toEqual([])
  })

  test("falls back to text from a closed content block when no delta was emitted", () => {
    const agent = runtime()
    agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Snapshot" } },
      },
    })

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: "Snapshot" }])
  })

  test("falls back to thinking from a closed content block when no delta was emitted", () => {
    const agent = runtime()
    agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Reasoning" } },
      },
    })

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
    }).events).toMatchObject([{ type: "thinking-delta", delta: "Reasoning" }])
  })

  test("restores active assistant text stream without duplicating snapshots", () => {
    const first = runtime()
    first.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
      },
    })

    const restored = runtime(first.snapshot())

    expect(restored.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        uuid: "assistant-1",
        message: { id: "message-1", content: [{ type: "text", text: "Hi there" }] },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: " there" }])
    expect(restored.snapshot().adapterState.emittedAssistantText).toBe("Hi there")
  })

  test("maps reasoning deltas, streamed tool inputs, and tool results", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let" },
        },
      },
    }).events).toMatchObject([{ type: "thinking-delta", delta: "Let" }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool-grep-1", name: "Grep", input: {} },
        },
      },
    }).events).toMatchObject([{ type: "tool-start", toolCallId: "tool-grep-1", toolName: "Grep" }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"foo\",\"path\":\"src\"}" },
        },
      },
    }).events).toMatchObject([{
      type: "tool-input",
      toolCallId: "tool-grep-1",
      input: { pattern: "foo", path: "src" },
    }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-grep-1", content: "src/example.ts:1:foo" }],
        },
      },
    }).events).toMatchObject([{
      type: "tool-output",
      toolCallId: "tool-grep-1",
      output: "src/example.ts:1:foo",
    }])
  })

  test("routes TodoWrite input to todo updates", () => {
    const agent = runtime()
    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool-todo-1", name: "TodoWrite", input: {} },
        },
      },
    }).events).toEqual([])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: "{\"todos\":[{\"content\":\"   \",\"status\":\"in_progress\"},{\"content\":\"Ship it\",\"status\":\"completed\"}]}",
          },
        },
      },
    }).events).toMatchObject([{
      type: "todo-update",
      todos: [
        { description: "Task", status: "in_progress" },
        { description: "Ship it", status: "completed" },
      ],
    }])
  })

  test("classifies Task tools as subagent work", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: { description: "Review", subagent_type: "code-reviewer" },
          },
        },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-task-1", toolName: "Task", kind: "collab_agent_tool_call" },
      { type: "tool-input", toolCallId: "tool-task-1", input: { description: "Review", subagent_type: "code-reviewer" } },
    ])
  })

  test("U2: classifies the Claude Agent wire name as subagent work", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-agent-1",
            name: "Agent",
            input: { description: "Review", subagent_type: "code-reviewer" },
          },
        },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-agent-1", toolName: "Agent", kind: "collab_agent_tool_call" },
      { type: "tool-input", toolCallId: "tool-agent-1", input: { description: "Review", subagent_type: "code-reviewer" } },
    ])
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

  test("maps non-question canUseTool callbacks to permission requests", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      method: "claude/can-use-tool",
      payload: {
        requestId: "perm-1",
        toolName: "Bash",
        input: { command: "bun test", cwd: "/repo" },
      },
    }).events).toMatchObject([{
      type: "permission-request",
      requestId: "perm-1",
      tool: "Bash",
      paths: ["/repo"],
    }])
  })

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

  test("reports SDK events that have no AgentRuntimeEvent mapping", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "citations_delta", citation: { type: "webpage", url: "https://example.com" } },
        },
      },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "claude_sdk.unmapped_event",
        severity: "info",
        details: { sdkEvent: "SDKPartialAssistantMessage.content_block_delta(citations_delta)" },
      },
    }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 180000 },
      },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "claude_sdk.unmapped_event",
        severity: "info",
        details: { sdkEvent: "SDKCompactBoundaryMessage" },
      },
    }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "conversation_reset",
        new_conversation_id: "conversation-2",
        uuid: "message-1",
        session_id: "session-1",
      },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "claude_sdk.unmapped_event",
        severity: "info",
        details: { sdkEvent: "SDKConversationResetMessage" },
      },
    }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "fallback" },
        },
      },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "claude_sdk.unmapped_event",
        severity: "info",
        details: { sdkEvent: "SDKPartialAssistantMessage.content_block_start(fallback)" },
      },
    }])
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

  test("maps result usage and completion", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sdk-session-result",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: { "claude-opus-4-6": { contextWindow: 200000 } },
      },
    }).events).toMatchObject([
      { type: "usage", contextSize: 200000, contextUsed: 24542 },
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sdk-session-result" },
    ])
  })

  test("treats user-aborted results as idle without a runtime error", () => {
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
    }).events).toMatchObject([{ type: "session-status", status: "idle" }])
  })

  test("treats cancelled and interrupted error results as idle", () => {
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
      }).events).toMatchObject([{ type: "session-status", status: "idle" }])
    }
  })
})
