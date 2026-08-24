import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { storeRows } from "../../test-utils/store-internals"
import { SdkRuntimeAdapter, type SdkRuntimeDriver } from "../shared/sdk-runtime-adapter"
import { ingestClaudeSdkMessage } from "./driver"

function claudeDriver(): SdkRuntimeDriver {
  return {
    type: "claude",
    setAuth() {},
    applyConfig() {},
    createAgentSession: async () => "claude-parent-thread",
    createRuntime: (threadId) => createAgentEventRuntime({
      harness: "claude",
      threadId,
      adapter: claudeSdkAdapter(),
      clock: () => 1,
      createId: (prefix = "id") => `${prefix}-1`,
    }),
    async runTurn(input) {
      const messages = [
        {
          type: "assistant",
          uuid: "parent-agent-call",
          session_id: "claude-parent-thread",
          parent_tool_use_id: null,
          message: {
            content: [{
              type: "tool_use",
              id: "tool-agent-1",
              name: "Agent",
              input: { description: "Review auth", subagent_type: "code-reviewer" },
            }],
          },
        },
        {
          type: "system",
          subtype: "task_started",
          uuid: "task-started-1",
          session_id: "claude-parent-thread",
          task_id: "task-1",
          tool_use_id: "tool-agent-1",
          description: "Review auth",
          subagent_type: "code-reviewer",
        },
        {
          type: "assistant",
          uuid: "child-read-call",
          session_id: "claude-parent-thread",
          parent_tool_use_id: "tool-agent-1",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-child-read-1",
              name: "Read",
              input: { file_path: "src/auth.ts" },
            }],
          },
        },
        {
          type: "user",
          uuid: "child-read-result",
          session_id: "claude-parent-thread",
          parent_tool_use_id: "tool-agent-1",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "tool-child-read-1",
              content: [{ type: "text", text: "auth source" }],
            }],
          },
        },
        {
          type: "system",
          subtype: "task_progress",
          uuid: "task-progress-1",
          session_id: "claude-parent-thread",
          task_id: "task-1",
          tool_use_id: "tool-agent-1",
          description: "Review auth",
          usage: { total_tokens: 9000, tool_uses: 1, duration_ms: 50 },
        },
        {
          type: "user",
          uuid: "parent-agent-result",
          session_id: "claude-parent-thread",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-agent-1", content: "opaque trailer" }],
          },
          tool_use_result: {
            status: "completed",
            agentId: "agent-42",
            content: [{ type: "text", text: "Review complete" }],
            totalTokens: 9000,
            totalToolUseCount: 1,
            totalDurationMs: 50,
          },
        },
        {
          type: "system",
          subtype: "task_notification",
          uuid: "task-completed-1",
          session_id: "claude-parent-thread",
          task_id: "task-1",
          tool_use_id: "tool-agent-1",
          status: "completed",
          output_file: "/provider/private/task-1.jsonl",
          summary: "Review complete",
        },
        {
          type: "result",
          subtype: "success",
          uuid: "turn-result-1",
          session_id: "claude-parent-thread",
          is_error: false,
          usage: { input_tokens: 10, output_tokens: 5 },
          modelUsage: { test: { contextWindow: 1000 } },
        },
      ]
      for (const message of messages) await ingestClaudeSdkMessage(input, message as never)
    },
    readRuntimeHealth: () => ({ status: "ok" }),
    configOptions: async () => [],
    peekConfigOptions: () => [],
  }
}

describe("Claude native subagent routing", () => {
  test("admits lifecycle under the parent and projects child tools only into the child Session", async () => {
    const store = storeRows(createMemoryRuntimeStore())
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new SdkRuntimeAdapter({ store, eventHub, driver: claudeDriver })
    const parent = await adapter.createSession("/repo")

    for await (const _ of adapter.sendMessage(parent.id, {
      parts: [{ type: "text", text: "Delegate review" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude", modelID: "test" },
    }, "/repo")) { /* drain */ }

    const child = (store.listSessions(path.resolve("/repo")) as Array<{ id: string; parentID?: string }>)
      .find((session) => session.id !== parent.id)
    expect(child).toMatchObject({ parentID: parent.id })
    expect(JSON.stringify(store.getMessages(child!.id))).toContain("tool-child-read-1")
    expect(JSON.stringify(store.getMessages(child!.id))).toContain("auth source")
    expect(JSON.stringify(store.getMessages(parent.id))).not.toContain("tool-child-read-1")
    expect(JSON.stringify(store.getMessages(parent.id))).not.toContain("auth source")

    const lifecycle = runtimeEvents
      .filter((event) => event.sessionId === parent.id && event.payload.type === "subagent-updated")
      .map((event) => event.payload)
    expect(lifecycle).toContainEqual(expect.objectContaining({
      type: "subagent-updated",
      toolCallId: "tool-agent-1",
      status: "pending",
      childSessionId: child!.id,
    }))
    expect(lifecycle).toContainEqual(expect.objectContaining({
      providerId: "agent-42",
      status: "completed",
    }))
    expect(runtimeEvents).not.toContainEqual(expect.objectContaining({
      sessionId: parent.id,
      payload: expect.objectContaining({ type: "usage", contextUsed: 9000 }),
    }))
    adapter.dispose()
  })
})
