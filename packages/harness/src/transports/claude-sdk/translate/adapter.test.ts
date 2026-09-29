import { describe, expect, test } from "bun:test"
import { USAGE_WINDOW_NAMES } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createAgentEventRuntime } from "../../../translate/runtime"
import {
  CLAUDE_SUBAGENT_USAGE_METHOD,
  claudeChildCorrelationKey,
  claudeSdkAdapter,
  claudeSubagentObservations,
  type ClaudeSubagentUsage,
} from "./adapter"
import { createClaudeTaskLedger } from "./task-ledger"
import { claudeRuntime as runtime } from "../test-support/runtime"

function sdkFrame(agent: ReturnType<typeof runtime>, payload: Record<string, unknown>) {
  return agent.ingest({ source: "claude.sdk.message", payload }).events
}

function streamFrame(event: Record<string, unknown>) {
  return { type: "stream_event", uuid: `stream-${String(event.type)}`, session_id: "sdk-session-1", parent_tool_use_id: null, event }
}

function messageStart(id: string, usage: Record<string, unknown>) {
  return streamFrame({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus", content: [], usage } })
}

function messageDelta(usage: Record<string, unknown>) {
  return streamFrame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage })
}

function assistantFrame(id: string, usage: Record<string, unknown>, owner: string | null = null) {
  return { type: "assistant", uuid: `assistant-${id}`, session_id: "sdk-session-1", parent_tool_use_id: owner, message: { id, content: [], usage } }
}

function resultFrame(usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: "result", subtype: "success", is_error: false, uuid: "result", session_id: "sdk-session-1", usage, ...extra }
}

function streamedRequest(id: string, opening: Record<string, unknown>, finalOutput: number) {
  return [
    messageStart(id, opening),
    assistantFrame(id, opening),
    messageDelta({ ...opening, output_tokens: finalOutput }),
    streamFrame({ type: "message_stop" }),
  ]
}

function meteredTokens(events: AgentRuntimeEvent[]) {
  return events.flatMap((event) => event.type === "usage" ? [event.observation?.tokens] : []).at(-1)
}

const FIRST_REQUEST = {
  input_tokens: 3,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 1000,
  cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
  output_tokens: 2,
}

const SECOND_REQUEST = {
  input_tokens: 5,
  cache_creation_input_tokens: 50,
  cache_read_input_tokens: 1200,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 50 },
  output_tokens: 1,
}

const TWO_REQUEST_FINALS = { input: 8, output: 900 + 4000, reasoning: null, cache: { read: 2200, write: 250, write1h: 200 } }

function parentAgentCall(toolCallId: string) {
  return {
    type: "assistant",
    uuid: `call-${toolCallId}`,
    session_id: "sdk-session-1",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: toolCallId, name: "Agent", input: { description: "Find the project name", subagent_type: "general-purpose" } }] },
  }
}

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

  test("preserves provider error explanation and recovery guidance", () => {
    const explanation = "API Error: This request was blocked. Try a new session or change your model."
    const events = runtime().ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant", error: "invalid_request",
        message: { content: [{ type: "text", text: explanation }] },
      },
    }).events
    expect(events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: `Claude assistant message failed: invalid_request\n${explanation}` },
    ])
    expect(events.some((event) => event.type === "text-delta")).toBe(false)
  })

  test("maps the CLI's transcript title entries to session titles by provenance", () => {
    const agent = runtime()
    expect(agent.ingest({
      source: "claude.sdk",
      method: "claude/session-store",
      payload: { type: "ai-title", aiTitle: "Date parser leap year tests", sessionId: "5bfc9161-3459-4626-9aa5-ba24c68022b6" },
    }).events).toMatchObject([{ type: "session-title", title: "Date parser leap year tests" }])
    expect(agent.ingest({
      source: "claude.sdk",
      method: "claude/session-store",
      payload: { type: "custom-title", customTitle: "Merge branch to dev", sessionId: "9cbf76fb-9c13-4eeb-a69f-693d34956b0f" },
    }).events).toMatchObject([{ type: "session-title", title: "Merge branch to dev", titleSource: "user" }])
    expect(agent.ingest({
      source: "claude.sdk",
      method: "claude/session-store",
      payload: { type: "attachment", attachment: { type: "goal_status", met: true } },
    }).events).toEqual([])
  })

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

  test("keeps the active assistant text stream without duplicating snapshots", () => {
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

    expect(first.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        uuid: "assistant-1",
        message: { id: "message-1", content: [{ type: "text", text: "Hi there" }] },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: " there" }])
    expect(first.state().reconciledAssistantTextByMessageId["message-1"]).toBe("Hi there")
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

  test("U5: registers complete child-owned tool blocks for child transcript routing", () => {
    const payload = {
      type: "assistant",
      uuid: "assistant-child-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: "tool-agent-parent-1",
      message: {
        content: [{ type: "tool_use", id: "tool-read-child-1", name: "Read", input: { file_path: "src/a.ts" } }],
      },
    }

    expect(claudeChildCorrelationKey(payload)).toBe("tool-agent-parent-1")
    expect(runtime().ingest({ source: "claude.sdk.message", payload }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-read-child-1", toolName: "Read" },
      { type: "tool-input", toolCallId: "tool-read-child-1", input: { file_path: "src/a.ts" } },
    ])
  })

  test("U5: normalizes Claude task lifecycle without requiring a tool use id", () => {
    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      description: "Ambient review",
      subagent_type: "code-reviewer",
    }, ledger)).toEqual([{
      observationId: "claude:task_started:task-start-1",
      harnessExecutionId: "sdk-session-1",
      stableCorrelationId: "task-1",
      status: "running",
      label: "Ambient review",
      description: "Ambient review",
      subagentType: "code-reviewer",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_updated",
      uuid: "task-update-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      patch: { status: "paused", is_backgrounded: true },
    }, ledger)).toEqual([{
      observationId: "claude:task_updated:task-update-1",
      harnessExecutionId: "sdk-session-1",
      stableCorrelationId: "task-1",
      mode: "background",
      status: "paused",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_updated",
      uuid: "task-update-2",
      session_id: "sdk-session-1",
      task_id: "task-1",
      patch: { end_time: 17, total_paused_ms: 4 },
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      status: "stopped",
      summary: "Stopped",
    }, ledger)[0]).toMatchObject({ stableCorrelationId: "task-1", status: "killed" })
  })

  test("U5: background_tasks_changed is a level signal and spawns no subagent row", () => {
    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-1",
      session_id: "sdk-session-1",
      tasks: [{ task_id: "task-1", task_type: "local_bash", description: "npm run build" }],
    }, ledger)).toEqual([])
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-2",
      session_id: "sdk-session-1",
      tasks: [],
    }, ledger)).toEqual([])
  })

  test("U5: a background subagent dropped from the live set gets the terminal it was never sent", () => {
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(parentAgentCall("tool-agent-1"), ledger)
    claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-agent",
      session_id: "sdk-session-1",
      task_id: "task-agent",
      tool_use_id: "tool-agent-1",
      description: "Review auth",
      subagent_type: "code-reviewer",
    }, ledger)
    claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      task_type: "local_bash",
      description: "npm run build",
    }, ledger)
    const live = (uuid: string, tasks: Array<{ task_id: string; task_type: string; description: string }>) => claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid,
      session_id: "sdk-session-1",
      tasks,
    }, ledger)

    expect(live("background-1", [
      { task_id: "task-agent", task_type: "local_agent", description: "Review auth" },
      { task_id: "task-bash", task_type: "local_bash", description: "npm run build" },
    ])).toEqual([])

    expect(live("background-2", [{ task_id: "task-bash", task_type: "local_bash", description: "npm run build" }])).toEqual([{
      observationId: "claude:background_tasks_changed:background-2:task-agent",
      harnessExecutionId: "sdk-session-1",
      stableCorrelationId: "task-agent",
      toolCallId: "tool-agent-1",
      toolCallRole: "spawn",
      status: "interrupted",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])

    expect(live("background-3", [])).toEqual([])
  })

  test("U5: only a Task subagent's own lifecycle becomes a subagent row", () => {
    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      tool_use_id: "bash-1",
      task_type: "local_bash",
      description: "npm run build",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-ambient",
      session_id: "sdk-session-1",
      task_id: "task-ambient",
      description: "Summarize the session",
      subagent_type: "housekeeping",
      skip_transcript: true,
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-ambient",
      session_id: "sdk-session-1",
      task_id: "task-ambient",
      status: "completed",
      summary: "Summarized",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      tool_use_id: "bash-1",
      status: "completed",
      summary: "npm run build finished",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-unknown",
      session_id: "sdk-session-1",
      task_id: "task-never-introduced",
      status: "completed",
      summary: "Something finished",
    }, ledger)).toEqual([])

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_progress",
      uuid: "task-progress-bash",
      session_id: "sdk-session-1",
      task_id: "task-bash",
      tool_use_id: "bash-1",
      description: "npm run build",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 10 },
    }, ledger)).toEqual([])
  })

  test("U5: a user message batching several tool results cannot attribute its single agent result", () => {
    expect(claudeSubagentObservations({
      type: "user",
      uuid: "batched-agent-results",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-agent-1", content: "first report" },
          { type: "tool_result", tool_use_id: "tool-agent-2", content: "second report" },
        ],
      },
      tool_use_result: { status: "completed", agentId: "agent-42", content: [{ type: "text", text: "first report" }] },
    }, createClaudeTaskLedger())).toEqual([])

    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(parentAgentCall("tool-agent-1"), ledger)
    expect(claudeSubagentObservations({
      type: "user",
      uuid: "single-agent-result",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-agent-1", content: "first report" }],
      },
      tool_use_result: { status: "completed", agentId: "agent-42", content: [{ type: "text", text: "first report" }] },
    }, ledger)).toEqual([{
      observationId: "claude:agent-result:single-agent-result:tool-agent-1",
      harnessExecutionId: "sdk-session-1",
      toolCallId: "tool-agent-1",
      toolCallRole: "spawn",
      status: "completed",
      providerId: "agent-42",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])
  })

  test("U5: every frame of a Task call the parent made names that call as the subagent's spawn", () => {
    const ledger = createClaudeTaskLedger()
    const edges = [
      parentAgentCall("toolu_1"),
      { type: "system", subtype: "task_started", uuid: "started", session_id: "sdk-session-1", task_id: "task-1", tool_use_id: "toolu_1", description: "Find the project name", subagent_type: "general-purpose", spawn_depth: 1 },
      { type: "system", subtype: "task_notification", uuid: "notified", session_id: "sdk-session-1", task_id: "task-1", tool_use_id: "toolu_1", status: "completed", summary: "Found it" },
      {
        type: "user",
        uuid: "result",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Found it" }] },
        tool_use_result: { status: "completed", agentId: "agent-1", content: [{ type: "text", text: "Found it" }] },
      },
    ].flatMap((frame) => claudeSubagentObservations(frame, ledger).map(({ toolCallId, toolCallRole }) => ({ toolCallId, toolCallRole })))

    expect(edges).toEqual(Array(4).fill({ toolCallId: "toolu_1", toolCallRole: "spawn" }))
  })

  for (const shape of ["finishes before the turn's result", "outlives the turn's result"] as const) {
    test(`U5: every frame of a background Task call the parent made names that call as the spawn when the child ${shape}`, () => {
      const ledger = createClaudeTaskLedger()
      const frame = (subtype: string, uuid: string, fields: Record<string, unknown>) => ({ type: "system", subtype, uuid, session_id: "sdk-session-1", ...fields })
      const parentText = { type: "assistant", uuid: "parent-text", session_id: "sdk-session-1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "DONE" }] } }
      const result = { type: "result", subtype: "success", uuid: "result", session_id: "sdk-session-1" }
      const child = [
        { type: "assistant", uuid: "child-text", session_id: "sdk-session-1", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "ok" }] } },
        frame("background_tasks_changed", "departed", { tasks: [] }),
        frame("task_updated", "updated", { task_id: "task-1", patch: { status: "completed" } }),
        frame("task_notification", "notified", { task_id: "task-1", tool_use_id: "toolu_1", status: "completed", summary: "ok" }),
      ]
      const frames = [
        { ...parentAgentCall("toolu_1"), message: { content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Find the project name", subagent_type: "general-purpose", run_in_background: true } }] } },
        frame("background_tasks_changed", "live", { tasks: [{ task_id: "task-1", task_type: "local_agent", description: "Find the project name" }] }),
        frame("task_started", "started", { task_id: "task-1", tool_use_id: "toolu_1", description: "Find the project name", subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1 }),
        {
          type: "user",
          uuid: "launched",
          session_id: "sdk-session-1",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
          tool_use_result: { isAsync: true, status: "async_launched", agentId: "task-1", description: "Find the project name" },
        },
        ...(shape === "outlives the turn's result" ? [parentText, result, ...child] : [...child, parentText, result]),
      ]
      const edges = frames.flatMap((item) => claudeSubagentObservations(item, ledger).map(({ stableCorrelationId, toolCallId, toolCallRole }) => (toolCallId ? { toolCallId, toolCallRole } : { stableCorrelationId })))
      const spawn = { toolCallId: "toolu_1", toolCallRole: "spawn" as const }

      expect(edges, "the call, task_started, the async launch, the departure, task_updated by its task id alone, task_notification").toEqual([spawn, spawn, spawn, spawn, { stableCorrelationId: "task-1" }, spawn])
    })
  }

  test("U5: a subagent a skill's forked execution runs keeps its call for routing but has no spawn edge", () => {
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations({
      type: "assistant",
      uuid: "skill-call",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "review-lanes" } }] },
    }, ledger)
    const forkResult = claudeSubagentObservations({
      type: "user",
      uuid: "skill-result",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "Skill completed (forked execution)." }] },
      tool_use_result: { status: "forked", agentId: "agent-fork", content: [{ type: "text", text: "done" }] },
    }, ledger)
    const lane = [
      { type: "system", subtype: "task_started", uuid: "lane-started", session_id: "sdk-session-1", task_id: "task-lane", tool_use_id: "toolu_forked_agent", description: "Review lane one", subagent_type: "general-purpose" },
      { type: "system", subtype: "task_notification", uuid: "lane-notified", session_id: "sdk-session-1", task_id: "task-lane", tool_use_id: "toolu_forked_agent", status: "completed", summary: "Reviewed" },
    ].flatMap((frame) => claudeSubagentObservations(frame, ledger))

    expect(forkResult).toEqual([{
      observationId: "claude:agent-result:skill-result:toolu_skill",
      harnessExecutionId: "sdk-session-1",
      toolCallId: "toolu_skill",
      status: "completed",
      providerId: "agent-fork",
      providerKind: "claude-agent",
      transcript: { kind: "messages" },
    }])
    expect(lane.map(({ stableCorrelationId, toolCallId, toolCallRole }) => ({ stableCorrelationId, toolCallId, toolCallRole }))).toEqual(
      Array(2).fill({ stableCorrelationId: "task-lane", toolCallId: "toolu_forked_agent", toolCallRole: undefined }),
    )
  })

  test("U5: subagent progress usage does not update the parent context gauge", () => {
    expect(runtime().ingest({
      source: "claude.sdk.message",
      payload: {
        type: "system",
        subtype: "task_progress",
        uuid: "task-progress-1",
        session_id: "sdk-session-1",
        task_id: "task-1",
        description: "Review",
        usage: { total_tokens: 5000, tool_uses: 8, duration_ms: 2000 },
        summary: "Checking files",
      },
    }).events).not.toContainEqual(expect.objectContaining({ type: "usage" }))
  })

  test("maps the SDK questions array without losing choices or multi-select behavior", () => {
    expect(runtime().ingest({
      source: "claude.sdk.message",
      method: "claude/can-use-tool",
      payload: {
        requestId: "question-1",
        toolName: "AskUserQuestion",
        input: { questions: [{
          question: "Which checks?",
          header: "Checks",
          multiSelect: true,
          options: [
            { label: "Unit", description: "Fast isolated checks" },
            { label: "Browser", description: "Exercise the UI" },
          ],
        }] },
      },
    }).events).toMatchObject([{
      type: "question",
      requestId: "question-1",
      questions: [{
        text: "Which checks?",
        header: "Checks",
        options: ["Unit", "Browser"],
        optionDescriptions: { Unit: "Fast isolated checks", Browser: "Exercise the UI" },
        multiple: true,
        custom: true,
      }],
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
        input: { command: "bun test", cwd: "/repo", description: "Run tests" },
      },
    }).events).toMatchObject([{
      type: "permission-request",
      requestId: "perm-1",
      tool: "Bash",
      paths: ["/repo"],
      details: { command: "bun test", reason: "Run tests" },
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

  test("a result completes the turn and reports its metered usage against the model's context window", () => {
    const agent = runtime()
    const opening = {
      input_tokens: 4,
      cache_creation_input_tokens: 2715,
      cache_read_input_tokens: 21144,
      output_tokens: 3,
    }
    for (const payload of streamedRequest("req-1", opening, 679)) sdkFrame(agent, payload)

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sdk-session-result",
        usage: { ...opening, output_tokens: 679 },
        modelUsage: { "claude-opus-4-6": { contextWindow: 200000 } },
      },
    }).events).toMatchObject([
      {
        type: "usage",
        contextSize: 200000,
        contextUsed: 24542,
        observation: {
          kind: "cumulative",
          nativeSessionId: "sdk-session-result",
          tokens: {
            input: 4,
            output: 679,
            reasoning: null,
            cache: { read: 21144, write: 2715 },
          },
        },
      },
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sdk-session-result" },
    ])
  })

  test("meters an assistant frame's request once by message id, apart from a child's requests", () => {
    const agent = runtime()
    const assistant = (id: string, usage: Record<string, number>, owner: string | null = null) =>
      sdkFrame(agent, assistantFrame(id, usage, owner))

    expect(meteredTokens(assistant("req-1", { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 20 })))
      .toEqual({ input: 100, output: 20, reasoning: null, cache: { read: 500, write: null } })

    expect(meteredTokens(assistant("req-1", { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 45 })))
      .toEqual({ input: 100, output: 45, reasoning: null, cache: { read: 500, write: null } })

    expect(meteredTokens(assistant("req-2", { input_tokens: 30, cache_read_input_tokens: 600, output_tokens: 10 })))
      .toEqual({ input: 130, output: 55, reasoning: null, cache: { read: 1100, write: null } })

    expect(meteredTokens(assistant("req-child", { input_tokens: 999, output_tokens: 999 }, "tool-1")))
      .toEqual({ input: 999, output: 999, reasoning: null, cache: { read: null, write: null } })

    expect(meteredTokens(assistant("req-3", { input_tokens: 7, cache_read_input_tokens: 40, output_tokens: 3 })))
      .toEqual({ input: 137, output: 58, reasoning: null, cache: { read: 1140, write: null } })
  })

  test("a turn that fails before its result meters each request's final output, not its opening snapshot", () => {
    const agent = runtime()
    const events = [
      ...streamedRequest("req-1", FIRST_REQUEST, 900),
      messageStart("req-2", SECOND_REQUEST),
      messageDelta({ input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 4000 }),
      assistantFrame("req-2", SECOND_REQUEST),
      {
        type: "assistant",
        uuid: "assistant-failed",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        error: "server_error",
        message: { id: "req-failed", content: [{ type: "text", text: "API Error: 500" }] },
      },
    ].flatMap((payload) => sdkFrame(agent, payload))

    expect(events).toContainEqual(expect.objectContaining({ type: "error" }))
    expect(meteredTokens(events)).toEqual(TWO_REQUEST_FINALS)
  })

  test("a result closes the turn with the metered sum, counting no request twice", () => {
    const agent = runtime()
    for (const payload of [
      ...streamedRequest("req-1", FIRST_REQUEST, 900),
      ...streamedRequest("req-2", SECOND_REQUEST, 4000),
    ]) sdkFrame(agent, payload)

    const closing = sdkFrame(agent, resultFrame({
      input_tokens: 8,
      cache_creation_input_tokens: 250,
      cache_read_input_tokens: 2200,
      output_tokens: 4900,
      cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 50 },
    }, { modelUsage: { "claude-opus": { contextWindow: 200000 } } }))

    expect(closing).toMatchObject([
      { type: "usage", contextSize: 200000, contextUsed: 5 + 4000 + 1200 + 50 },
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sdk-session-1" },
    ])
    expect(meteredTokens(closing)).toEqual(TWO_REQUEST_FINALS)
  })

  test("a query that ends two CLI turns meters both, whether or not the first result is ingested", () => {
    for (const ingestFirstResult of [true, false]) {
      const agent = runtime()
      for (const payload of streamedRequest("req-1", FIRST_REQUEST, 900)) sdkFrame(agent, payload)
      if (ingestFirstResult) {
        sdkFrame(agent, resultFrame({ input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 900 }))
      }
      for (const payload of streamedRequest("req-2", SECOND_REQUEST, 4000)) sdkFrame(agent, payload)

      const closing = sdkFrame(agent, resultFrame({ input_tokens: 5, cache_creation_input_tokens: 50, cache_read_input_tokens: 1200, output_tokens: 4000 }))

      expect(meteredTokens(closing)).toEqual(TWO_REQUEST_FINALS)
    }
  })

  test("a child's requests meter the child's own total, corrected by its transcript, and never the parent's", () => {
    const agent = runtime()
    for (const payload of streamedRequest("req-parent", FIRST_REQUEST, 900)) sdkFrame(agent, payload)
    const childOpening = { input_tokens: 4, cache_read_input_tokens: 700, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 0 }, output_tokens: 2 }
    const correction = (id: string, usage: Record<string, unknown>) => agent.ingest({
      source: "claude.sdk",
      method: CLAUDE_SUBAGENT_USAGE_METHOD,
      payload: { parent_tool_use_id: "tool-agent-1", session_id: "sdk-session-1", message: { id, usage } } satisfies ClaudeSubagentUsage,
    }).events

    expect(meteredTokens(sdkFrame(agent, assistantFrame("req-child-1", childOpening, "tool-agent-1"))))
      .toEqual({ input: 4, output: 2, reasoning: null, cache: { read: 700, write: 30, write1h: 30 } })
    expect(meteredTokens(correction("req-child-1", { ...childOpening, output_tokens: 310 })))
      .toEqual({ input: 4, output: 310, reasoning: null, cache: { read: 700, write: 30, write1h: 30 } })
    expect(correction("req-child-1", childOpening)).toEqual([])

    const closing = sdkFrame(agent, resultFrame({ input_tokens: 3, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 900 }))
    expect(meteredTokens(closing)).toEqual({ input: 3, output: 900, reasoning: null, cache: { read: 1000, write: 200, write1h: 200 } })
  })

  test("each observation names the model that served its requests, one stream per model", () => {
    const agent = runtime()
    const start = (id: string, model: string, usage: Record<string, unknown>) =>
      sdkFrame(agent, streamFrame({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], usage } }))
    const observed = (events: AgentRuntimeEvent[]) => events.flatMap((event) => event.type === "usage" && event.observation
      ? [{ scope: event.observation.scope, model: event.observation.model, input: event.observation.tokens.input }]
      : [])

    expect(observed(start("req-1", "claude-opus-4-6", { input_tokens: 10, output_tokens: 1 }))).toEqual([
      { scope: undefined, model: "claude-opus-4-6", input: 10 },
    ])
    expect(observed(start("req-2", "claude-sonnet-4-5", { input_tokens: 20, output_tokens: 1 }))).toEqual([
      { scope: "main@claude-sonnet-4-5", model: "claude-sonnet-4-5", input: 20 },
    ])
    expect(observed(start("req-3", "claude-opus-4-6", { input_tokens: 30, output_tokens: 1 }))).toEqual([
      { scope: undefined, model: "claude-opus-4-6", input: 40 },
    ])
    expect(observed(sdkFrame(agent, {
      type: "assistant",
      uuid: "assistant-child",
      session_id: "sdk-session-1",
      parent_tool_use_id: "tool-agent-1",
      message: { id: "req-child", model: "claude-haiku-4-5", content: [], usage: { input_tokens: 7, output_tokens: 1 } },
    }))).toEqual([{ scope: "tool-agent-1", model: "claude-haiku-4-5", input: 7 }])
    expect(observed(agent.ingest({
      source: "claude.sdk",
      method: CLAUDE_SUBAGENT_USAGE_METHOD,
      payload: { parent_tool_use_id: "tool-agent-2", session_id: "sdk-session-1", message: { id: "req-mirrored", usage: { input_tokens: 9 }, model: "claude-haiku-4-5" } } satisfies ClaudeSubagentUsage,
    }).events)).toEqual([{ scope: "tool-agent-2", model: "claude-haiku-4-5", input: 9 }])
  })

  test("a message_delta after its request stopped merges into no request", () => {
    const agent = runtime()
    for (const payload of streamedRequest("req-1", FIRST_REQUEST, 900)) sdkFrame(agent, payload)

    expect(sdkFrame(agent, messageDelta({ output_tokens: 5000 }))).toEqual([])

    const closing = sdkFrame(agent, resultFrame({}))
    expect(meteredTokens(closing)).toEqual({ input: 3, output: 900, reasoning: null, cache: { read: 1000, write: 200, write1h: 200 } })
  })

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

  test("binds a create_subagent result to the host-minted child and classifies the call as task work", () => {
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
            id: "tool-mcp-spawn-1",
            name: "mcp__claxedo__create_subagent",
            input: { harness: "codex", prompt: "Consult on the plan" },
          },
        },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-mcp-spawn-1", kind: "collab_agent_tool_call", display: { intent: "task" } },
      { type: "tool-input", toolCallId: "tool-mcp-spawn-1" },
    ])

    const ledger = createClaudeTaskLedger()
    expect(claudeSubagentObservations(toolCallFrame("tool-mcp-spawn-1", "mcp__claxedo__create_subagent"), ledger)).toEqual([])

    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9", status: "running" })
    expect(claudeSubagentObservations({
      type: "user",
      uuid: "user-mcp-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-mcp-spawn-1", content: [{ type: "text", text: binding }] }],
      },
      tool_use_result: [{ type: "text", text: binding }],
    }, ledger)).toEqual([{
      observationId: "claude:host-subagent:user-mcp-1:tool-mcp-spawn-1",
      harnessExecutionId: "sdk-session-1",
      subagentKey: "subagent_host",
      toolCallId: "tool-mcp-spawn-1",
      toolCallRole: "spawn",
      status: "running",
      providerId: "child-9",
      providerKind: "claxedo",
      childSessionId: "child-9",
      transcript: { kind: "live" },
    }])
  })

  test("a create_subagent call a subagent made binds its host-minted child for routing but has no spawn edge on the parent", () => {
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(parentAgentCall("toolu_1"), ledger)
    claudeSubagentObservations({ ...toolCallFrame("tool-mcp-nested-1", "mcp__claxedo__create_subagent"), parent_tool_use_id: "toolu_1" }, ledger)
    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_nested", sessionId: "child-10" })
    const [observation] = claudeSubagentObservations({ ...toolResultFrame([["tool-mcp-nested-1", binding]]), parent_tool_use_id: "toolu_1" }, ledger)
    expect(observation).toMatchObject({ subagentKey: "subagent_nested", toolCallId: "tool-mcp-nested-1", childSessionId: "child-10" })
    expect(observation?.toolCallRole).toBeUndefined()
  })

  test("a binding in the result of any other tool, or of a call the turn never made, binds nothing", () => {
    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_forged", sessionId: "someone-elses-session" })
    for (const [toolUseId, toolName] of [["tool-bash-1", "Bash"], ["tool-mcp-list-1", "mcp__claxedo__session_list"]] as const) {
      const ledger = createClaudeTaskLedger()
      claudeSubagentObservations(toolCallFrame(toolUseId, toolName), ledger)
      expect(claudeSubagentObservations(toolResultFrame([[toolUseId, binding]]), ledger)).toEqual([])
    }
    expect(claudeSubagentObservations(toolResultFrame([["tool-mcp-spawn-1", binding]]), createClaudeTaskLedger())).toEqual([])
  })

  test("a batched delivery binds only the block that answers create_subagent, from that block's own text", () => {
    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9" })
    const forged = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_forged", sessionId: "someone-elses-session" })
    const ledger = createClaudeTaskLedger()
    claudeSubagentObservations(toolCallFrame("tool-bash-1", "Bash"), ledger)
    claudeSubagentObservations(toolCallFrame("tool-mcp-spawn-1", "mcp__claxedo__create_subagent"), ledger)

    expect(claudeSubagentObservations({
      ...toolResultFrame([["tool-bash-1", forged], ["tool-mcp-spawn-1", binding]]),
      tool_use_result: [{ type: "text", text: forged }],
    }, ledger)).toEqual([expect.objectContaining({
      toolCallId: "tool-mcp-spawn-1",
      subagentKey: "subagent_host",
      childSessionId: "child-9",
    })])
  })
})

function toolCallFrame(toolUseId: string, toolName: string) {
  return {
    type: "assistant",
    uuid: `assistant-${toolUseId}`,
    session_id: "sdk-session-1",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }] },
  }
}

function toolResultFrame(results: ReadonlyArray<readonly [toolUseId: string, text: string]>) {
  return {
    type: "user",
    uuid: "user-results-1",
    session_id: "sdk-session-1",
    parent_tool_use_id: null,
    message: {
      content: results.map(([toolUseId, text]) => ({ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] })),
    },
  }
}

describe("claudeSdkAdapter rate limits", () => {
  const emitted = (info: Record<string, unknown>) => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    return agent.ingest({
      source: "claude.sdk",
      method: "claude/rate_limit_event",
      payload: { type: "rate_limit_event", uuid: "rate-1", session_id: "sdk-session-1", rate_limit_info: info },
    }).events.map(({ harness: _harness, threadId: _threadId, raw: _raw, ...event }) => event)
  }

  test("names the five-hour, weekly and opus windows the way the usage read does", () => {
    expect(emitted({ status: "allowed", rateLimitType: "five_hour", utilization: 42.4, resetsAt: 1_757_700_000 })).toEqual([{
      type: "rate-limit",
      status: "ok",
      usedPercent: 42,
      resetsAt: 1_757_700_000_000,
      limitId: "five_hour",
      limitName: "session",
    }])
    expect(emitted({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 90 })[0])
      .toMatchObject({ status: "ok", limitId: "seven_day", limitName: "weekly" })
    expect(emitted({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 5 })[0])
      .toMatchObject({ limitId: "seven_day_opus", limitName: "weekly_opus" })
    for (const [slot, name] of Object.entries(USAGE_WINDOW_NAMES.claude ?? {})) {
      expect(emitted({ status: "allowed", rateLimitType: slot, utilization: 1 })[0]).toMatchObject({ limitName: name })
    }
  })

  test("passes a window the vendor added since through under its own name", () => {
    expect(emitted({ status: "allowed", rateLimitType: "seven_day_sonnet", utilization: 12 })[0])
      .toMatchObject({ limitId: "seven_day_sonnet", limitName: "seven_day_sonnet" })
  })

  test("a window spelled like a prototype member names itself, not an inherited value", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(emitted({ status: "allowed", rateLimitType: key, utilization: 1 })[0])
        .toMatchObject({ limitId: key, limitName: key })
    }
  })

  test("a rate_limit refusal is a temporary rate limit unless the last window report rejected a plan window", () => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    const window = (status: string) => agent.ingest({
      source: "claude.sdk",
      method: "claude/rate_limit_event",
      payload: { type: "rate_limit_event", uuid: `rate-${status}`, session_id: "sdk-session-1", rate_limit_info: { status, rateLimitType: "five_hour" } },
    })
    const refusal = () => agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant", error: "rate_limit",
        message: { content: [{ type: "text", text: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later." }] },
      },
    }).events.find((event) => event.type === "error")

    expect(refusal()).toMatchObject({ type: "error", errorClass: "rate_limit" })
    window("rejected")
    expect(refusal()).toMatchObject({ type: "error", errorClass: "usage_limit" })
    window("allowed")
    expect(refusal()).toMatchObject({ type: "error", errorClass: "rate_limit" })
  })

  test("the owner's recorded 429, with no window report before it in its session, is a temporary rate limit", () => {
    const events = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    }).ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        message: {
          id: "9ee31f29-0ea3-48fa-91c1-91a9e43c812b",
          model: "<synthetic>",
          role: "assistant",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          type: "message",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later." }],
        },
        parent_tool_use_id: null,
        session_id: "b66f22f2-d1b5-442e-8f63-bc12b84276d9",
        uuid: "c47b02b7-8985-4da0-859c-fdf3dbe6736f",
        error: "rate_limit",
        is_api_error_message: true,
      },
    }).events
    expect(events.find((event) => event.type === "error")).toMatchObject({ errorClass: "rate_limit" })
  })

  test("a refusal inside a recorded rejected weekly window names the window and when it resets", () => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    agent.ingest({
      source: "claude.sdk",
      method: "claude/rate_limit_event",
      payload: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1790391600,
          rateLimitType: "seven_day",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
          isUsingOverage: false,
          unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1790129400 }, seven_day: { utilization: 1, resetsAt: 1790391600 } },
        },
        uuid: "b33b8089-cf07-417f-8f1c-cb639d495f83",
        session_id: "8f4a7cac-7236-426d-befc-31ea7d872d95",
      },
    })
    const refusal = agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        message: {
          id: "62753f45-5dbd-4494-952e-99c0e5408885",
          model: "<synthetic>",
          role: "assistant",
          stop_reason: "stop_sequence",
          type: "message",
          content: [{ type: "text", text: "You've hit your weekly limit · resets Sep 26 at 8:30am (Asia/Calcutta)" }],
        },
        parent_tool_use_id: null,
        session_id: "8f4a7cac-7236-426d-befc-31ea7d872d95",
        uuid: "27cdc408-be34-43d1-9ffe-d435254e8d41",
        error: "rate_limit",
        is_api_error_message: true,
      },
    }).events.find((event) => event.type === "error")

    expect(refusal).toMatchObject({
      type: "error",
      error: [
        `You've reached your Claude weekly limit. It will reset at ${new Date(1_790_391_600_000).toLocaleString()}.`,
        "You've hit your weekly limit · resets Sep 26 at 8:30am (Asia/Calcutta)",
      ].join("\n"),
      errorClass: "usage_limit",
    })
  })

  test("an assistant failure that is no limit carries no class of its own", () => {
    const [, error] = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    }).ingest({ source: "claude.sdk.message", payload: { type: "assistant", error: "invalid_request", message: { content: [] } } }).events
    expect(error).toMatchObject({ type: "error" })
    expect(error).not.toHaveProperty("errorClass")
  })

  test("only a rejection is a limit", () => {
    expect(emitted({ status: "rejected", rateLimitType: "five_hour", utilization: 100, resetsAt: 1_757_700_000 })).toEqual([{
      type: "rate-limit",
      status: "limited",
      usedPercent: 100,
      resetsAt: 1_757_700_000_000,
      limitId: "five_hour",
      limitName: "session",
    }])
  })

  test("omits the percentage and the window name the vendor left out", () => {
    const [event] = emitted({ status: "allowed" })
    expect(event).toEqual({ type: "rate-limit", status: "ok", resetsAt: null })
    expect(Object.keys(event ?? {}).sort()).toEqual(["resetsAt", "status", "type"])
  })

  test("clamps a utilization outside 0..100", () => {
    expect(emitted({ status: "allowed", utilization: 137.6 })[0]).toMatchObject({ usedPercent: 100 })
    expect(emitted({ status: "allowed", utilization: -4 })[0]).toMatchObject({ usedPercent: 0 })
  })

  test("normalises the reset to epoch milliseconds, whichever unit the vendor sent", () => {
    expect(emitted({ status: "allowed", resetsAt: 1_757_700_000 })[0]).toMatchObject({ resetsAt: 1_757_700_000_000 })
    expect(emitted({ status: "allowed", resetsAt: 1_757_700_000_000 })[0]).toMatchObject({ resetsAt: 1_757_700_000_000 })
    expect(emitted({ status: "allowed", resetsAt: "soon" })[0]).toMatchObject({ resetsAt: null })
  })
})
