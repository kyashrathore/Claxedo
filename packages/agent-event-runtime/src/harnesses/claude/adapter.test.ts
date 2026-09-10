import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import type { RuntimeSnapshot } from "../../core/state"
import { createClientPresentationProjection } from "../../projections/client-presentation/projection"
import { TOOL_ATTACHMENT_INLINE_MAX_BYTES } from "../tool-attachments"
import {
  claudeChildCorrelationKey,
  claudeSdkAdapter,
  claudeSubagentObservations,
  type ClaudeSdkAdapterState,
} from "./adapter"

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
  for (const failed of [false, true]) {
  test(`task notification cannot consume the authoritative Bash ${failed ? "error" : "output"}`, () => {
    const agent = runtime()
    const projection = createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "reply-1" })
    const ingest = (payload: unknown) => agent.ingest({ source: "claude.sdk.message", payload }).events.flatMap((event) => projection.ingest(event))
    ingest({ type: "assistant", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "node work.cjs" } }] } })
    const notification = { type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "bash-1", status: failed ? "failed" : "completed", summary: "Run work.cjs", uuid: "done-1" }
    expect(claudeSubagentObservations(notification)[0]).toMatchObject({ status: failed ? "failed" : "completed" })
    ingest(notification)
    const result = ingest({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "actual tool result", is_error: failed }] }, tool_use_result: { stdout: failed ? "" : "actual tool result", stderr: failed ? "actual tool result" : "" } })
    expect(result.at(-1)).toMatchObject({ payload: {
      type: "message.part.updated", properties: { part: { state: failed ? { status: "error", error: "actual tool result" } : { status: "completed", output: "actual tool result" } } },
    } })
  })

  }

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

  test("projects native task results and preserves IDs across runtime restoration", () => {
    let agent = runtime()
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
    agent = runtime(agent.snapshot())
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

  function readImageSession(input: { cwd?: string; filePath: string; data: string }) {
    const agent = runtime()
    const projection = createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "reply-1" })
    const ingest = (payload: unknown) => {
      const events = agent.ingest({ source: "claude.sdk.message", payload }).events
      return { events, envelopes: events.flatMap((event) => projection.ingest(event)) }
    }
    if (input.cwd) ingest({ type: "system", subtype: "init", cwd: input.cwd, uuid: "init-1" })
    ingest({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-read-image-1", name: "Read", input: { file_path: input.filePath } }] },
    })
    const { events, envelopes } = ingest({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-read-image-1",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: input.data } },
            { type: "text", text: "This image may contain text." },
            { type: "text", text: "Read 1 image." },
          ],
        }],
      },
    })
    const part = envelopes.map((envelope) => envelope.payload).find(
      (payload): payload is Extract<typeof payload, { type: "message.part.updated" }> => payload.type === "message.part.updated",
    )?.properties.part
    return { events, part }
  }

  test("canonicalises Claude's tool names so the grouping vocabularies match", () => {
    const agent = runtime()
    const projection = createClientPresentationProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "reply-1",
    })
    const parts = [
      { id: "c1", name: "Bash", input: { command: "bun test" } },
      { id: "c2", name: "Read", input: { file_path: "/repo/a.ts" } },
      { id: "c3", name: "Grep", input: { pattern: "x" } },
    ].flatMap(({ id, name, input }) =>
      agent
        .ingest({
          source: "claude.sdk.message",
          payload: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } },
        })
        .events.flatMap((event) => projection.ingest(event)),
    )
      .map((envelope) => envelope.payload)
      .filter((payload): payload is Extract<typeof payload, { type: "message.part.updated" }> =>
        payload.type === "message.part.updated",
      )
      .map((payload) => payload.properties.part)
      .filter((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool")

    expect([...new Set(parts.map((part) => part.tool))].sort()).toEqual(["bash", "grep", "read"])
  })

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

  test("carries a read inside the session cwd by path alongside its unchanged text output", () => {
    const { events, part } = readImageSession({ cwd: "/repo", filePath: "/repo/docs/screenshot.png", data: png })

    expect(events).toMatchObject([{
      type: "tool-output",
      toolCallId: "tool-read-image-1",
      output: "This image may contain text.\nRead 1 image.",
      attachments: [{
        kind: "workspace-file",
        mime: "image/png",
        path: "docs/screenshot.png",
        sourcePath: "/repo/docs/screenshot.png",
        filename: "screenshot.png",
      }],
    }])
    expect(events[0]).not.toHaveProperty("attachments.0.url")

    expect(part).toMatchObject({
      type: "tool",
      /* Canonicalised at the projection: Claude sends `Read`, every downstream
         vocabulary matches lowercase. */
      tool: "read",
      state: {
        status: "completed",
        output: "This image may contain text.\nRead 1 image.",
        attachments: [{
          type: "file",
          sessionID: "session-1",
          messageID: "reply-1",
          mime: "image/png",
          filename: "screenshot.png",
          url: "file://docs/screenshot.png",
          location: { kind: "workspace-file", path: "docs/screenshot.png" },
        }],
      },
    })
  })

  test("carries a small read outside the session cwd by value", () => {
    const { events, part } = readImageSession({ cwd: "/repo", filePath: "/tmp/screenshot.png", data: png })

    expect(events).toMatchObject([{
      type: "tool-output",
      output: "This image may contain text.\nRead 1 image.",
      attachments: [{ kind: "inline", mime: "image/png", url: `data:image/png;base64,${png}`, filename: "screenshot.png" }],
    }])
    expect(part).toMatchObject({
      state: {
        status: "completed",
        output: "This image may contain text.\nRead 1 image.",
        attachments: [{ type: "file", mime: "image/png", filename: "screenshot.png", url: `data:image/png;base64,${png}` }],
      },
    })
    const attachment = part?.type === "tool" && part.state.status === "completed" ? part.state.attachments?.[0] : undefined
    expect(attachment).not.toHaveProperty("location")
  })

  test("drops an oversized read outside the session cwd but keeps its size and text output", () => {
    const oversized = "A".repeat(TOOL_ATTACHMENT_INLINE_MAX_BYTES)
    const { events, part } = readImageSession({ cwd: "/repo", filePath: "/tmp/huge.png", data: oversized })

    expect(events).toMatchObject([{
      type: "tool-output",
      output: "This image may contain text.\nRead 1 image.",
      attachments: [{
        kind: "unretained",
        mime: "image/png",
        filename: "huge.png",
        sourcePath: "/tmp/huge.png",
        bytes: `data:image/png;base64,${oversized}`.length,
      }],
    }])
    expect(part).toMatchObject({
      state: {
        status: "completed",
        output: "This image may contain text.\nRead 1 image.",
        attachments: [{
          type: "file",
          mime: "image/png",
          filename: "huge.png",
          url: "file:///tmp/huge.png",
          location: { kind: "unretained", bytes: `data:image/png;base64,${oversized}`.length },
        }],
      },
    })
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
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_started",
      uuid: "task-start-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      description: "Ambient review",
      subagent_type: "code-reviewer",
    })).toEqual([{
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
    })[0]).toMatchObject({
      stableCorrelationId: "task-1",
      status: "paused",
      mode: "background",
    })

    expect(claudeSubagentObservations({
      type: "system",
      subtype: "task_notification",
      uuid: "task-done-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      status: "stopped",
      summary: "Stopped",
    })[0]).toMatchObject({ stableCorrelationId: "task-1", status: "killed" })
  })

  test("U5: treats background_tasks_changed as replacement-level membership, not completion edges", () => {
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-1",
      session_id: "sdk-session-1",
      tasks: [{ task_id: "task-1", task_type: "agent", description: "Review" }],
    })[0]).toMatchObject({
      stableCorrelationId: "task-1",
      status: "running",
      mode: "background",
    })
    expect(claudeSubagentObservations({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-2",
      session_id: "sdk-session-1",
      tasks: [],
    })).toEqual([])
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

  test("meters provisional per-request usage so a turn that never reaches result still counts", () => {
    const agent = runtime()
    const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
      agent.ingest({
        source: "claude.sdk.message",
        payload: { type: "assistant", uuid: `uuid-${id}`, message: { id, content: [], usage }, ...extra },
      })

    // Request 1 seeds the turn accumulator.
    expect(assistant("req-1", { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 20 }).events).toMatchObject([{
      type: "usage",
      observation: { kind: "cumulative", tokens: { input: 100, output: 20, reasoning: null, cache: { read: 500, write: null } } },
    }])

    // A re-emission of the SAME request replaces its snapshot — never adds.
    expect(assistant("req-1", { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 45 }).events).toMatchObject([{
      type: "usage",
      observation: { kind: "cumulative", tokens: { input: 100, output: 45, reasoning: null, cache: { read: 500, write: null } } },
    }])

    // Request 2 adds to the turn total.
    expect(assistant("req-2", { input_tokens: 30, cache_read_input_tokens: 600, output_tokens: 10 }).events).toMatchObject([{
      type: "usage",
      observation: { kind: "cumulative", tokens: { input: 130, output: 55, reasoning: null, cache: { read: 1100, write: null } } },
    }])

    // Child (subagent) messages never feed the parent turn accumulator.
    expect(
      assistant("req-child", { input_tokens: 999, output_tokens: 999 }, { parent_tool_use_id: "tool-1" }).events,
    ).not.toContainEqual(expect.objectContaining({ type: "usage" }))

    // The result's usage stays authoritative, and the accumulator resets for
    // the next turn: its first request seeds from zero again.
    agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sdk-session-1",
        usage: { input_tokens: 130, cache_read_input_tokens: 1100, output_tokens: 55 },
      },
    })
    expect(assistant("req-3", { input_tokens: 7, cache_read_input_tokens: 40, output_tokens: 3 }).events).toMatchObject([{
      type: "usage",
      observation: { kind: "cumulative", tokens: { input: 7, output: 3, reasoning: null, cache: { read: 40, write: null } } },
    }])
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

    const call = {
      type: "assistant",
      uuid: "assistant-mcp-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: "tool-mcp-spawn-1",
          name: "mcp__claxedo__create_subagent",
          input: { harness: "codex", prompt: "Consult on the plan" },
        }],
      },
    }
    expect(claudeSubagentObservations(call)).toEqual([])

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
    })).toEqual([{
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
})
