import { describe, expect, test } from "bun:test"
import { translatorRuntime } from "../../../test-support/translator-runtime"
import {
  cursorSdkAdapter,
  cursorRuntimeMessage,
  cursorSubagentObservations,
} from "./adapter"

function bare(events: readonly Record<string, unknown>[]) {
  return events.map(({ harness: _harness, threadId: _threadId, raw: _raw, ...event }) => event)
}

function runtime() {
  return translatorRuntime({
    harness: "cursor-sdk",
    threadId: "thread-1",
    adapter: cursorSdkAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
  })
}

describe("cursorSdkAdapter", () => {
  test("assistant and thinking frames are deltas: every chunk reaches the transcript, repeats included", () => {
    const agent = runtime()
    const assistant = (text: string) => ({ source: "cursor.sdk.message", payload: { type: "assistant", agent_id: "agent-1", run_id: "run-1",
      message: { role: "assistant", content: [{ type: "text", text }] } } })
    const thinking = (text: string, duration?: number) => ({ source: "cursor.sdk.message", payload: { type: "thinking", agent_id: "agent-1", run_id: "run-1", text,
      ...(duration === undefined ? {} : { thinking_duration_ms: duration }) } })
    const deltas = [assistant("Hel"), assistant("lo"), assistant("lo"), assistant("o!"), thinking("Th"), thinking("Th"), thinking("", 1200)]
      .flatMap((frame) => agent.ingest(frame).events)
    expect(deltas).toMatchObject([
      { type: "text-delta", delta: "Hel" }, { type: "text-delta", delta: "lo" }, { type: "text-delta", delta: "lo" }, { type: "text-delta", delta: "o!" },
      { type: "thinking-delta", delta: "Th" }, { type: "thinking-delta", delta: "Th" },
    ])
    expect(deltas).toHaveLength(6)
  })

  test("a run's usage frames add up, carry reasoning tokens, and leave the context window unknown", () => {
    const agent = runtime()
    const usage = (usage: Record<string, number>) => agent.ingest({ source: "cursor.sdk.message",
      payload: { type: "usage", agent_id: "agent-1", run_id: "run-1", usage } }).events
    usage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, totalTokens: 154, reasoningTokens: 6 })
    expect(bare(usage({ inputTokens: 7, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 18 }))).toEqual([{
      type: "usage",
      contextSize: 0,
      contextUsed: 0,
      observation: {
        kind: "cumulative",
        providerObservationId: "run-1",
        tokens: { input: 107, output: 31, reasoning: 6, cache: { read: 30, write: 4 } },
      },
    }])
  })

  test("a conversation summary is a completed compaction; the prompt echo, request id and system frame show nothing", () => {
    const agent = runtime()
    const frame = (payload: Record<string, unknown>) => bare(agent.ingest({ source: "cursor.sdk.message",
      payload: { agent_id: "agent-1", run_id: "run-1", ...payload } }).events)
    expect(frame({ type: "task", text: "Summary of the earlier conversation" }))
      .toEqual([{ type: "session-compaction", phase: "completed", summary: "Summary of the earlier conversation" }])
    expect(frame({ type: "user", message: { role: "user", content: [{ type: "text", text: "steered text" }] } })).toEqual([])
    expect(frame({ type: "request", request_id: "request-1" })).toEqual([])
    expect(frame({ type: "system", subtype: "init" })).toEqual([])
  })

  test("a frame, status or tool status the transport does not know leaves one debug note per kind and never throws", () => {
    const agent = runtime()
    const frame = (payload: Record<string, unknown>) => agent.ingest({ source: "cursor.sdk.message",
      payload: { agent_id: "agent-1", run_id: "run-1", ...payload } }).events
    const note = (kind: string) => [{ type: "diagnostic", diagnostic: { code: "cursor_sdk.ignored_frame", severity: "debug", details: { kind } } }]
    expect(frame({ type: "mailbox", body: "x".repeat(10_000) })).toMatchObject(note("message:mailbox"))
    expect(frame({ type: "mailbox", body: "y" })).toEqual([])
    expect(frame({ type: "status", status: "PAUSED" })).toMatchObject(note("status:PAUSED"))
    expect(frame({ type: "tool_call", call_id: "c1", name: "shell", status: "queued", args: {} })).toMatchObject(note("tool_call:queued"))
    expect(JSON.stringify(agent.state().notedKinds)).not.toContain("xxxx")
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

  test("a shell exit code decides the completion, whatever the result status says", () => {
    const shellCompletion = (callId: string, result: unknown) => runtime().ingest({
      source: "cursor.sdk.message",
      payload: {
        type: "tool_call",
        agent_id: "agent-1",
        run_id: "run-1",
        call_id: callId,
        name: "shell",
        status: "completed",
        args: { command: "bun test", workingDirectory: "/repo" },
        result,
      },
    }).events.filter((event) => event.type === "tool-output" || event.type === "tool-error")

    expect(shellCompletion("shell-nonzero-success", { status: "success", value: { exitCode: 1, stdout: "", stderr: "1 fail" } }))
      .toMatchObject([{ type: "tool-error", toolCallId: "shell-nonzero-success", metadata: { exitCode: 1 } }])
    expect(shellCompletion("shell-nonzero-error", { status: "error", value: { exitCode: 1, stdout: "", stderr: "1 fail" } }))
      .toMatchObject([{ type: "tool-error", toolCallId: "shell-nonzero-error", metadata: { exitCode: 1 } }])
    expect(shellCompletion("shell-zero", { status: "success", value: { exitCode: 0, stdout: "passed", stderr: "" } }))
      .toMatchObject([{ type: "tool-output", toolCallId: "shell-zero", metadata: { exitCode: 0 } }])
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

  test("the run ends at the host's result: SDK status frames are progress, and a failed run keeps the SDK's reason and class", () => {
    const agent = runtime()
    agent.ingest({ source: "cursor.sdk.message", payload: { type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "tool-shell-1",
      name: "shell", status: "running", args: { command: "bun test" } } })
    agent.ingest({ source: "cursor.sdk.message", payload: { type: "usage", agent_id: "agent-1", run_id: "run-1",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 } } })
    const status = (value: string) => bare(agent.ingest({ source: "cursor.sdk.message",
      payload: { type: "status", agent_id: "agent-1", run_id: "run-1", status: value, message: "[resource_exhausted] slow down" } }).events)
    expect(status("RUNNING")).toEqual([{ type: "session-status", status: "busy" }])
    for (const terminal of ["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]) expect(status(terminal)).toEqual([])
    expect(Object.keys(agent.state().toolsByCallId)).toEqual(["tool-shell-1"])
    expect(bare(agent.ingest({ source: "cursor.local-run-stream", payload: { schemaVersion: 1, type: "result", agentId: "agent-1", runId: "run-1",
      status: "error", error: { message: "You've hit your usage limit", code: "PRO_USER_USAGE_LIMIT" } } }).events)).toEqual([
      { type: "session-status", status: "error" },
      { type: "error", error: "You've hit your usage limit", errorClass: "usage_limit" },
    ])
    expect(agent.state()).toEqual({ toolsByCallId: {}, usageByRunId: {}, notedKinds: [] })
    expect(bare(runtime().ingest({ source: "cursor.local-run-stream", payload: { schemaVersion: 1, type: "result", agentId: "agent-1", runId: "run-2",
      status: "error", error: { message: "[unavailable] HTTP 429" } } }).events)).toEqual([
      { type: "session-status", status: "error" },
      { type: "error", error: "[unavailable] HTTP 429" },
    ])
    expect(bare(runtime().ingest({ source: "cursor.local-run-stream", payload: { schemaVersion: 1, type: "result", agentId: "agent-1", runId: "run-3",
      status: "finished" } }).events)).toEqual([{ type: "session-status", status: "idle" }, { type: "finish", sessionId: "run-3" }])
  })

  test("ends a cancelled local run as cancelled, never as finished", () => {
    expect(runtime().ingest({
      source: "cursor.local-run-stream",
      payload: { schemaVersion: 1, type: "result", agentId: "agent-1", runId: "run-3", status: "cancelled" },
    }).events).toMatchObject([
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId: "run-3" },
    ])
  })

  test("binds a create_subagent result to the host-minted child and raises nothing while it runs", () => {
    const args = { providerIdentifier: "claxedo", toolName: "create_subagent", args: { harness: "codex", prompt: "Consult on the plan" } }
    const running = { type: "tool_call", agent_id: "parent-agent", run_id: "run-1", call_id: "mcp-spawn-1", name: "mcp", status: "running", args }
    expect(cursorSubagentObservations(running)).toEqual([])
    expect(cursorSubagentObservations({
      ...running,
      status: "completed",
      result: { status: "success", value: { content: [{ text: { text: JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9" }) } }], isError: false } },
    })).toEqual([{
      observationId: "cursor:host-subagent:run-1:mcp-spawn-1",
      harnessExecutionId: "run-1",
      subagentKey: "subagent_host",
      toolCallId: "mcp-spawn-1",
      toolCallRole: "spawn",
      providerId: "child-9",
      providerKind: "claxedo",
      childSessionId: "child-9",
      transcript: { kind: "live" },
    }])
    expect(runtime().ingest({ source: "cursor.sdk.message", payload: running }).events[0])
      .toMatchObject({ type: "tool-start", toolName: "mcp__claxedo__create_subagent", kind: "collab_agent_tool_call", display: { intent: "task" } })
  })

  test("an MCP call is named by its server and tool, and a result the server marks as an error fails the row", () => {
    const agent = runtime()
    const args = { providerIdentifier: "github", toolName: "search", args: {} }
    expect(agent.ingest({ source: "cursor.sdk.message", payload: { type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "m2", name: "mcp",
      status: "completed", args, result: { status: "success", value: { content: [{ text: { text: "boom" } }], isError: true } } } }).events).toMatchObject([
      { type: "tool-start", toolCallId: "m2", toolName: "mcp__github__search", kind: "mcp_tool_call", display: { intent: "mcp" } },
      { type: "tool-input", toolCallId: "m2" },
      { type: "tool-error", toolCallId: "m2", error: "boom" },
    ])
  })

  test("todo statuses keep cancelled, and delete reads as a deletion", () => {
    const agent = runtime()
    expect(bare(agent.ingest({ source: "cursor.sdk.message", payload: { type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "td", name: "updateTodos",
      status: "completed", args: { todos: [{ content: "a", status: "cancelled" }, { content: "b", status: "inProgress" }] } } }).events)).toEqual([{
      type: "todo-update", todos: [{ id: "0", description: "a", status: "cancelled" }, { id: "1", description: "b", status: "in_progress" }] }])
    expect(agent.ingest({ source: "cursor.sdk.message", payload: { type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "d1", name: "delete",
      status: "running", args: { path: "/repo/old.ts" } } }).events[0]).toMatchObject({ type: "tool-start", kind: "delete", display: { intent: "delete" } })
  })
})

test("Cursor SDK image results preserve each MCP image and attach a generated image's file, never infer from a read path", () => {
  const complete = (name: string, value: unknown, status = "success") => runtime().ingest({
    source: "cursor.sdk.message",
    payload: { type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "image", name, status: "completed", args: { path: "/tmp/image.png" }, result: { status, value } },
  }).events.find((event) => event.type === "tool-output")
  expect(complete("mcp", { content: [{ image: { data: "YWJj", mimeType: "image/png" } }, { text: { text: "hello" } }, { image: { data: "ZGVm", mimeType: "image/jpeg" } }] })).toMatchObject({
    attachments: [{ kind: "inline", mime: "image/png", url: "data:image/png;base64,YWJj" }, { kind: "inline", mime: "image/jpeg", url: "data:image/jpeg;base64,ZGVm" }],
  })
  expect(complete("generateImage", { filePath: "/tmp/cat.png" })).toMatchObject({ attachments: [{ kind: "tool-file", mime: "image/*", path: "/tmp/cat.png", filename: "cat.png" }] })
  expect(complete("read", { content: "image.png", totalLines: 1, fileSize: 9 })).not.toHaveProperty("attachments")
  expect(complete("mcp", { content: [{ image: { data: "YWJj", mimeType: "image/png" } }] }, "error")).toBeUndefined()
})
