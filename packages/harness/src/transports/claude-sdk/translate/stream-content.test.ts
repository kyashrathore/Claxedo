import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
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

  test("a command streams to the transcript as it is typed, and the complete input replaces it", () => {
    const agent = runtime()
    const delta = (partial_json: string) =>
      agent.ingest({
        source: "claude.sdk.message",
        payload: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } } },
      }).events
    agent.ingest({
      source: "claude.sdk.message",
      payload: { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-bash-1", name: "Bash", input: {} } } },
    })

    expect(delta('{"comm')).toEqual([])
    expect(delta('and":"git sta')).toMatchObject([{ type: "tool-input", toolCallId: "tool-bash-1", input: { command: "git sta" } }])
    expect(delta('tus --short"')).toMatchObject([{ type: "tool-input", input: { command: "git status --short" } }])
    expect(delta(',"descr')).toEqual([])
    expect(delta('iption":"Show ')).toMatchObject([{ type: "tool-input", input: { command: "git status --short", description: "Show " } }])
    expect(delta('changes"}')).toMatchObject([{ type: "tool-input", input: { command: "git status --short", description: "Show changes" } }])
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
})
