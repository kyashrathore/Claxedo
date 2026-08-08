import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import type { RuntimeSnapshot } from "../../core/state"
import {
  cursorSdkAdapter,
  cursorRuntimeMessage,
  cursorSubagentObservations,
  type CursorSdkAdapterState,
} from "./adapter"

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
    }).events).toMatchObject([{
      type: "usage",
      contextSize: 200,
      contextUsed: 200,
      observation: {
        kind: "cumulative",
        tokens: {
          input: 120,
          output: 30,
          reasoning: null,
          cache: { read: 40, write: 10 },
        },
      },
    }])
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
      { type: "tool-status", toolCallId: "task-1", status: "running" },
    ])
  })

  test("U8: concurrent same-type tasks produce distinct spawn observations", () => {
    const task = (callId: string) => cursorSubagentObservations({
      type: "tool_call",
      agent_id: "parent-agent",
      run_id: "run-1",
      call_id: callId,
      name: "Task",
      status: "running",
      args: {
        description: "Review",
        prompt: "Review the code",
        subagentType: { kind: "code-reviewer" },
      },
    })[0]

    expect(task("task-a")).toMatchObject({
      toolCallId: "task-a",
      toolCallRole: "spawn",
      status: "running",
      subagentType: "code-reviewer",
      transcript: { kind: "none" },
    })
    expect(task("task-b")?.observationId).not.toBe(task("task-a")?.observationId)
  })

  test("U8: re-entry adopts an optional provider handle at spawn", () => {
    expect(cursorSubagentObservations({
      type: "tool_call",
      run_id: "run-1",
      call_id: "task-resume",
      name: "Task",
      status: "running",
      args: { description: "Continue", prompt: "Continue", resume: "cursor-agent-7" },
    })).toMatchObject([{
      toolCallId: "task-resume",
      toolCallRole: "interaction",
      providerId: "cursor-agent-7",
      providerKind: "cursor-agent",
      status: "running",
    }])
  })

  test("U8: completion accepts a late or permanently absent provider handle", () => {
    expect(cursorSubagentObservations({
      type: "tool_call",
      run_id: "run-1",
      call_id: "task-late",
      name: "Task",
      status: "completed",
      args: { description: "Review", prompt: "Review" },
      result: {
        status: "success",
        value: {
          agentId: "cursor-agent-9",
          isBackground: true,
          backgroundReason: "agentRequest",
          transcriptPath: "/private/provider/transcript.jsonl",
        },
      },
    })).toMatchObject([{
      toolCallId: "task-late",
      providerId: "cursor-agent-9",
      mode: "background",
      status: "completed",
      transcript: { kind: "none" },
    }])

    expect(cursorSubagentObservations({
      type: "tool_call",
      run_id: "run-1",
      call_id: "task-no-handle",
      name: "Task",
      status: "completed",
      args: { description: "Review", prompt: "Review" },
      result: {
        status: "success",
        value: { isBackground: false, backgroundReason: "unspecified" },
      },
    })[0]).toEqual(expect.objectContaining({
      toolCallId: "task-no-handle",
      status: "completed",
      transcript: { kind: "none" },
    }))
    expect(cursorSubagentObservations({
      type: "tool_call",
      run_id: "run-1",
      call_id: "task-no-handle",
      name: "Task",
      status: "completed",
      args: { description: "Review", prompt: "Review" },
      result: {
        status: "success",
        value: { isBackground: false, backgroundReason: "unspecified" },
      },
    })[0]).not.toHaveProperty("providerId")
  })

  test("U8: error results never inspect a success value or expose a transcript path", () => {
    const message = {
      type: "tool_call",
      agent_id: "parent-agent",
      run_id: "run-1",
      call_id: "task-error",
      name: "Task",
      status: "error",
      args: { description: "Review", prompt: "Review" },
      result: {
        status: "error",
        error: { transcriptPath: "/secret/error.jsonl", value: { agentId: "invalid" } },
      },
    }

    expect(cursorSubagentObservations(message)).toMatchObject([{
      toolCallId: "task-error",
      status: "failed",
      transcript: { kind: "none" },
    }])
    expect(cursorSubagentObservations(message)[0]).not.toHaveProperty("providerId")
    expect(JSON.stringify(runtime().ingest({ source: "cursor.sdk.message", payload: cursorRuntimeMessage(message) }).events))
      .not.toContain("/secret/error.jsonl")
  })

  test("U8: completion promotes task payload metadata without crossing raw transcript data", () => {
    const agent = runtime()
    agent.ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "parent-agent",
        run_id: "run-1",
        call_id: "task-complete",
        name: "Task",
        status: "running",
        args: { description: "Review", prompt: "Review" },
      },
    })

    const events = agent.ingest({
      source: "cursor.sdk.message",
      payload: cursorRuntimeMessage({
        type: "tool_call",
        agent_id: "parent-agent",
        run_id: "run-1",
        call_id: "task-complete",
        name: "Task",
        status: "completed",
        args: { description: "Review", prompt: "Review", agentId: "cursor-agent-10" },
        result: {
          status: "success",
          value: {
            agentId: "cursor-agent-10",
            isBackground: false,
            durationMs: 25,
            backgroundReason: "unspecified",
            conversationSteps: [{ private: "child transcript" }],
            transcriptPath: "/private/provider/transcript.jsonl",
          },
        },
      }),
    }).events

    expect(events).toMatchObject([
      { type: "tool-input", toolCallId: "task-complete", input: { agentId: "cursor-agent-10" } },
      {
        type: "tool-output",
        toolCallId: "task-complete",
        output: { agentId: "cursor-agent-10", isBackground: false, durationMs: 25 },
        metadata: { cursor: { subagent: { agentId: "cursor-agent-10", transcript: "unavailable" } } },
      },
    ])
    expect(JSON.stringify(events)).not.toContain("/private/provider/transcript.jsonl")
    expect(JSON.stringify(events)).not.toContain("child transcript")
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
