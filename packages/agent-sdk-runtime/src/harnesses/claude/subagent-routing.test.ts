import path from "node:path"
import { describe, expect, test } from "bun:test"
import { executeTestTurn } from "../../test-utils/execution-binding"
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter, createClaudeTaskLedger } from "@claxedo/agent-event-runtime/harnesses/claude"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { SdkRuntimeAdapter, type SdkRuntimeDriver } from "../shared/sdk-runtime-adapter"
import { ingestClaudeSdkMessage } from "./driver"

function claudeDriverFor(messages: unknown[]) {
  return (): SdkRuntimeDriver => ({ ...claudeDriver(), async runTurn(input) {
    const tasks = createClaudeTaskLedger()
    for (const message of messages) await ingestClaudeSdkMessage(input, message as never, tasks)
  } })
}

function claudeDriver(): SdkRuntimeDriver {
  return {
    type: "claude",
    instructionChannel: "turn-system-prompt",
    interactions: { permissions: true, questions: false },
    setAuth() {},
    applyConfig() {},
    createAgentSession: async () => ({ id: "claude-parent-thread" }),
    deleteAgentSession() {},
    createRuntime: (threadId) => createAgentEventRuntime({
      harness: "claude",
      threadId,
      adapter: claudeSdkAdapter(),
      clock: () => 1,
      createId: (prefix = "id") => `${prefix}-1`,
    }),
    async runTurn(input) {
      const turn = [
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
      const tasks = createClaudeTaskLedger()
      for (const message of turn) await ingestClaudeSdkMessage(input, message as never, tasks)
    },
    readRuntimeHealth: () => ({ status: "ok" }),
    configOptions: async () => [],
    peekConfigOptions: () => [],
  }
}

describe("Claude native subagent routing", () => {
  test("admits lifecycle under the parent and projects child tools only into the child Session", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new SdkRuntimeAdapter({ store, eventHub, driver: claudeDriver })
    const parent = await adapter.createSession(path.resolve("/repo"))

    for await (const _ of executeTestTurn(adapter, parent.id, {
      parts: [{ type: "text", text: "Delegate review" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude", modelID: "test" },
    }, path.resolve("/repo"))) { /* drain */ }

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
    await adapter.dispose()
  })

  test("publishes the child turn's own start and completion, so a live reader sees it settle", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new SdkRuntimeAdapter({ store, eventHub, driver: claudeDriver })
    const parent = await adapter.createSession(path.resolve("/repo"))

    for await (const _ of executeTestTurn(adapter, parent.id, {
      parts: [{ type: "text", text: "Delegate review" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude", modelID: "test" },
    }, path.resolve("/repo"))) { /* drain */ }

    const child = (store.listSessions(path.resolve("/repo")) as Array<{ id: string; parentID?: string }>)
      .find((session) => session.id !== parent.id)
    const childLifecycle = runtimeEvents
      .filter((event) => event.sessionId === child!.id)
      .map((event) => event.payload)
    expect(childLifecycle).toContainEqual({ type: "session-status", status: "busy" })
    expect(childLifecycle).toContainEqual({ type: "finish", sessionId: child!.id })
    const childAssistant = (store.getMessages(child!.id) as Array<{ info: { role: string; time?: { completed?: number } } }>)
      .find((message) => message.info.role === "assistant")
    expect(childAssistant?.info.time?.completed).toEqual(expect.any(Number))
    await adapter.dispose()
  })

  test("replays a task row's buffered child events once the spawn tool call is known", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: claudeDriverFor([
        {
          type: "system",
          subtype: "task_started",
          uuid: "task-started-1",
          session_id: "claude-parent-thread",
          task_id: "task-1",
          description: "Review auth",
          subagent_type: "code-reviewer",
        },
        {
          type: "assistant",
          uuid: "child-read-call",
          session_id: "claude-parent-thread",
          parent_tool_use_id: "tool-agent-1",
          message: {
            content: [{ type: "tool_use", id: "tool-child-read-1", name: "Read", input: { file_path: "src/auth.ts" } }],
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
          subagent_type: "code-reviewer",
          usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
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
      ]),
    })
    const parent = await adapter.createSession(path.resolve("/repo"))

    for await (const _ of executeTestTurn(adapter, parent.id, {
      parts: [{ type: "text", text: "Delegate review" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude", modelID: "test" },
    }, path.resolve("/repo"))) { /* drain */ }

    const child = (store.listSessions(path.resolve("/repo")) as Array<{ id: string; parentID?: string }>)
      .find((session) => session.id !== parent.id)
    expect(child).toMatchObject({ parentID: parent.id })
    expect(JSON.stringify(store.getMessages(child!.id))).toContain("tool-child-read-1")
    await adapter.dispose()
  })

  test("leaves a host-owned child session alone when the turn ends", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9", status: "running" })
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: claudeDriverFor([
        {
          type: "assistant",
          uuid: "parent-host-call",
          session_id: "claude-parent-thread",
          parent_tool_use_id: null,
          message: {
            content: [{
              type: "tool_use",
              id: "tool-mcp-spawn-1",
              name: "mcp__claxedo__create_subagent",
              input: { harness: "codex", prompt: "Consult on the plan" },
            }],
          },
        },
        {
          type: "user",
          uuid: "parent-host-result",
          session_id: "claude-parent-thread",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-mcp-spawn-1", content: [{ type: "text", text: binding }] }],
          },
          tool_use_result: [{ type: "text", text: binding }],
        },
      ]),
    })
    const parent = await adapter.createSession(path.resolve("/repo"))

    for await (const _ of executeTestTurn(adapter, parent.id, {
      parts: [{ type: "text", text: "Ask a peer" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude", modelID: "test" },
    }, path.resolve("/repo"))) { /* drain */ }

    const lifecycle = runtimeEvents
      .filter((event) => event.sessionId === parent.id && event.payload.type === "subagent-updated")
      .map((event) => event.payload)
    expect(lifecycle.at(-1)).toMatchObject({ subagentKey: "subagent_host", status: "running" })
    expect(lifecycle).not.toContainEqual(expect.objectContaining({ status: "interrupted" }))
    await adapter.dispose()
  })

  test("settles a background subagent the live set dropped without a terminal of its own", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: claudeDriverFor([
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
              input: { description: "Review auth", subagent_type: "code-reviewer", run_in_background: true },
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
          type: "system",
          subtype: "background_tasks_changed",
          uuid: "background-1",
          session_id: "claude-parent-thread",
          tasks: [
            { task_id: "task-1", task_type: "local_agent", description: "Review auth" },
            { task_id: "task-bash", task_type: "local_bash", description: "npm run build" },
          ],
        },
        {
          type: "assistant",
          uuid: "child-read-call",
          session_id: "claude-parent-thread",
          parent_tool_use_id: "tool-agent-1",
          message: {
            content: [{ type: "tool_use", id: "tool-child-read-1", name: "Read", input: { file_path: "src/auth.ts" } }],
          },
        },
        {
          type: "system",
          subtype: "background_tasks_changed",
          uuid: "background-2",
          session_id: "claude-parent-thread",
          tasks: [{ task_id: "task-bash", task_type: "local_bash", description: "npm run build" }],
        },
      ]),
    })
    const parent = await adapter.createSession(path.resolve("/repo"))

    for await (const _ of executeTestTurn(adapter, parent.id, {
      parts: [{ type: "text", text: "Delegate review" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude", modelID: "test" },
    }, path.resolve("/repo"))) { /* drain */ }

    const lifecycle = runtimeEvents
      .filter((event) => event.sessionId === parent.id && event.payload.type === "subagent-updated")
      .map((event) => event.payload)
    expect(new Set(lifecycle.map((event) => (event as { subagentKey: string }).subagentKey)).size).toBe(1)
    expect(lifecycle.at(-1)).toMatchObject({ toolCallId: "tool-agent-1", status: "interrupted" })
    const child = (store.listSessions(path.resolve("/repo")) as Array<{ id: string; parentID?: string }>)
      .find((session) => session.id !== parent.id)
    expect(child).toMatchObject({ lastTurn: expect.objectContaining({ status: "cancelled", reason: "interrupted" }) })
    expect(JSON.stringify(store.getMessages(child!.id))).toContain("tool-child-read-1")
    await adapter.dispose()
  })

  test("terminalizes a foreground subagent the turn ended without settling", async () => {
    const store = createMemoryRuntimeStore()
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: claudeDriverFor([
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
          type: "assistant",
          uuid: "child-read-call",
          session_id: "claude-parent-thread",
          parent_tool_use_id: "tool-agent-1",
          message: {
            content: [{ type: "tool_use", id: "tool-child-read-1", name: "Read", input: { file_path: "src/auth.ts" } }],
          },
        },
      ]),
    })
    const parent = await adapter.createSession(path.resolve("/repo"))

    for await (const _ of executeTestTurn(adapter, parent.id, {
      parts: [{ type: "text", text: "Delegate review" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude", modelID: "test" },
    }, path.resolve("/repo"))) { /* drain */ }

    const lifecycle = runtimeEvents
      .filter((event) => event.sessionId === parent.id && event.payload.type === "subagent-updated")
      .map((event) => event.payload)
    expect(lifecycle.at(-1)).toMatchObject({ status: "interrupted" })
    const child = (store.listSessions(path.resolve("/repo")) as Array<{ id: string; parentID?: string; status?: string }>)
      .find((session) => session.id !== parent.id)
    expect(child).toMatchObject({ lastTurn: expect.objectContaining({ status: "cancelled", reason: "interrupted" }) })
    await adapter.dispose()
  })
})
