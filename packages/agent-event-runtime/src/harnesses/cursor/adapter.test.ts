import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import type { RuntimeSnapshot } from "../../core/state"
import { cursorSdkAdapter, type CursorSdkAdapterState } from "./adapter"

function runtime(initialSnapshot?: RuntimeSnapshot<CursorSdkAdapterState>) {
  return createAgentEventRuntime({
    harness: "cursor-sdk",
    threadId: "thread-1",
    adapter: cursorSdkAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
    ...(initialSnapshot ? { initialSnapshot } : {}),
  })
}

describe("cursorSdkAdapter", () => {
  test("maps assistant snapshots without duplicating restored text", () => {
    const first = runtime()

    expect(first.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "assistant",
        agent_id: "agent-1",
        run_id: "run-1",
        message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: "Hel" }])

    const restored = runtime(first.snapshot())

    expect(restored.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "assistant",
        agent_id: "agent-1",
        run_id: "run-1",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: "lo" }])
    expect(restored.snapshot().adapterState.assistantTextByRunId["run-1"]).toBe("Hello")
  })

  test("maps thinking snapshots without duplicate deltas", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: { type: "thinking", agent_id: "agent-1", run_id: "run-1", text: "Think" },
    }).events).toMatchObject([{ type: "thinking-delta", delta: "Think" }])

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: { type: "thinking", agent_id: "agent-1", run_id: "run-1", text: "Thinking" },
    }).events).toMatchObject([{ type: "thinking-delta", delta: "ing" }])
  })

  test("maps usage messages", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "usage",
        agent_id: "agent-1",
        run_id: "run-1",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
          totalTokens: 200,
        },
      },
    }).events).toMatchObject([{ type: "usage", contextSize: 200, contextUsed: 200 }])
  })

  test("maps tool call lifecycle events", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "agent-1",
        run_id: "run-1",
        call_id: "tool-shell-1",
        name: "shell",
        status: "running",
        args: { command: "bun test", workingDirectory: "/repo" },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "tool-shell-1", toolName: "shell", kind: "command_execution" },
      { type: "tool-input", toolCallId: "tool-shell-1", input: { command: "bun test", workingDirectory: "/repo", cwd: "/repo" } },
      { type: "tool-status", toolCallId: "tool-shell-1", status: "running" },
    ])

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "agent-1",
        run_id: "run-1",
        call_id: "tool-shell-1",
        name: "shell",
        status: "completed",
        args: { command: "bun test", workingDirectory: "/repo" },
        result: { status: "success", value: { exitCode: 0, stdout: "passed", stderr: "" } },
      },
    }).events).toMatchObject([{
      type: "tool-output",
      toolCallId: "tool-shell-1",
      output: { exitCode: 0, stdout: "passed", stderr: "" },
    }])
  })

  test("routes UpdateTodos and Task tools to first-class runtime events", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "agent-1",
        run_id: "run-1",
        call_id: "todo-1",
        name: "updateTodos",
        status: "completed",
        args: { todos: [{ content: "Ship adapter", status: "inProgress" }] },
      },
    }).events).toMatchObject([{
      type: "todo-update",
      todos: [{ description: "Ship adapter", status: "in_progress" }],
    }])

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "agent-1",
        run_id: "run-1",
        call_id: "task-1",
        name: "Task",
        status: "running",
        args: { description: "Review", subagentType: { kind: "code-reviewer" } },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "task-1", kind: "collab_agent_tool_call" },
      { type: "tool-input", toolCallId: "task-1", input: { description: "Review", subagentType: { kind: "code-reviewer" } } },
      { type: "subagent-spawned", childSessionId: "code-reviewer" },
      { type: "tool-status", toolCallId: "task-1", status: "running" },
    ])
  })

  test("U8: concurrent same-type Cursor subagents receive distinct host identities", () => {
    const agent = runtime()
    const spawn = (toolCallId: string) => agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "agent-1",
        run_id: "run-1",
        call_id: toolCallId,
        name: "Task",
        status: "running",
        args: { description: toolCallId, subagentType: { kind: "code-reviewer" } },
      },
    }).events
      .map((event) => event as unknown as { type: string; childSessionId?: string; subagentKey?: string })
      .find((event) => event.type === "subagent-spawned" || event.type === "subagent-updated")

    const first = spawn("task-1")
    const second = spawn("task-2")
    const firstIdentity = first?.subagentKey ?? first?.childSessionId
    const secondIdentity = second?.subagentKey ?? second?.childSessionId

    expect(firstIdentity).toBeDefined()
    expect(secondIdentity).toBeDefined()
    expect(firstIdentity).not.toBe("code-reviewer")
    expect(secondIdentity).not.toBe("code-reviewer")
    expect(secondIdentity).not.toBe(firstIdentity)
  })

  test("maps status and local stream terminal events", () => {
    const agent = runtime()

    agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "assistant",
        agent_id: "agent-1",
        run_id: "run-1",
        message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
      },
    })
    agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "agent-1",
        run_id: "run-1",
        call_id: "tool-shell-1",
        name: "shell",
        status: "running",
        args: { command: "bun test" },
      },
    })
    expect(Object.keys(agent.snapshot().adapterState.assistantTextByRunId)).toEqual(["run-1"])
    expect(Object.keys(agent.snapshot().adapterState.toolsByCallId)).toEqual(["tool-shell-1"])

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: { type: "status", agent_id: "agent-1", run_id: "run-1", status: "RUNNING" },
    }).events).toMatchObject([{ type: "session-status", status: "busy" }])

    expect(agent.ingest({
      source: "cursor.sdk.message",
      payload: { type: "status", agent_id: "agent-1", run_id: "run-1", status: "FINISHED" },
    }).events).toMatchObject([
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "run-1" },
    ])
    expect(agent.snapshot().adapterState).toEqual({
      assistantTextByRunId: {},
      thinkingTextByRunId: {},
      toolsByCallId: {},
    })

    const local = runtime()
    local.ingest({
      source: "cursor.sdk.message",
      payload: { type: "thinking", agent_id: "agent-1", run_id: "run-2", text: "Think" },
    })
    expect(agent.ingest({
      source: "cursor.local-run-stream",
      payload: { schemaVersion: 1, type: "result", agentId: "agent-1", runId: "run-2", status: "error", errorCode: "failed" },
    }).events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: "failed" },
    ])
    expect(local.ingest({
      source: "cursor.local-run-stream",
      payload: { schemaVersion: 1, type: "result", agentId: "agent-1", runId: "run-2", status: "error", errorCode: "failed" },
    }).snapshot.adapterState).toEqual({
      assistantTextByRunId: {},
      thinkingTextByRunId: {},
      toolsByCallId: {},
    })
  })
})
