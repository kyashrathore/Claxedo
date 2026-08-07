import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { cursorSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/cursor"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { storeRows } from "../../test-utils/store-internals"
import { SdkRuntimeAdapter, type SdkRuntimeDriver } from "../shared/sdk-runtime-adapter"
import { ingestCursorSdkMessage } from "./driver"

function cursorDriver(transcriptRegistrar?: Parameters<typeof ingestCursorSdkMessage>[2]): SdkRuntimeDriver {
  return {
    type: "cursor",
    setAuth() {},
    applyConfig() {},
    createAgentSession: async () => "cursor-parent-agent",
    createRuntime: (threadId) => createAgentEventRuntime({
      harness: "cursor",
      threadId,
      adapter: cursorSdkAdapter(),
      clock: () => 1,
      createId: (prefix = "id") => `${prefix}-1`,
    }),
    async runTurn(input) {
      const messages = [
        {
          type: "tool_call",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          call_id: "task-a",
          name: "Task",
          status: "running",
          args: { description: "Review auth", subagentType: { name: "reviewer" } },
        },
        {
          type: "tool_call",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          call_id: "task-b",
          name: "Task",
          status: "running",
          args: { description: "Review auth", subagentType: { name: "reviewer" } },
        },
        {
          type: "tool_call",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          call_id: "task-a",
          name: "Task",
          status: "completed",
          args: { description: "Review auth", subagentType: { name: "reviewer" } },
          result: {
            status: "success",
            value: {
              agentId: "cursor-child-a",
              isBackground: false,
              durationMs: 50,
              transcriptPath: "/provider/private/cursor-child-a.jsonl",
              conversationSteps: [{ text: "private child transcript" }],
            },
          },
        },
        {
          type: "tool_call",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          call_id: "task-b",
          name: "Task",
          status: "completed",
          args: { description: "Review auth", subagentType: { name: "reviewer" } },
          result: { status: "success", value: { isBackground: true, durationMs: 25 } },
        },
        {
          type: "tool_call",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          call_id: "task-reentry",
          name: "Task",
          status: "running",
          args: { description: "Continue review", agentId: "cursor-existing-child" },
        },
        {
          type: "tool_call",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          call_id: "task-reentry",
          name: "Task",
          status: "completed",
          args: { description: "Continue review", agentId: "cursor-existing-child" },
          result: { status: "success", value: { isBackground: false } },
        },
        {
          type: "tool_call",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          call_id: "task-error",
          name: "Task",
          status: "error",
          args: { description: "Inspect failure" },
          result: {
            status: "error",
            error: {
              message: "child failed",
              transcriptPath: "/provider/private/error.jsonl",
              value: { agentId: "must-not-adopt" },
            },
          },
        },
        {
          type: "status",
          agent_id: "cursor-parent-agent",
          run_id: "cursor-run-1",
          status: "FINISHED",
        },
      ]
      for (const message of messages) await ingestCursorSdkMessage(input, message as never, transcriptRegistrar)
    },
    readRuntimeHealth: () => ({ status: "ok" }),
    configOptions: async () => [],
    peekConfigOptions: () => [],
  }
}

describe("Cursor native subagent routing", () => {
  test("U8: admits stable lifecycle identities with conditional opaque file transcripts", async () => {
    const store = storeRows(createMemoryRuntimeStore())
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    const transcriptRegistrations: unknown[] = []
    const transcriptOpens: unknown[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: (host) => cursorDriver(host.transcriptRegistrar),
      transcriptRegistrar: {
        register(input) {
          transcriptRegistrations.push(input)
          return Promise.resolve({ state: "ready", handle: "cursor_transcript_opaque" })
        },
        open(input) {
          transcriptOpens.push(input)
          return Promise.resolve({ state: "ready", messages: [{ type: "text", text: "resolved child transcript" }] })
        },
      },
    })
    const parent = await adapter.createSession("/repo")

    for await (const _ of adapter.sendMessage(parent.id, {
      parts: [{ type: "text", text: "Delegate reviews" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "cursor", modelID: "test" },
    }, "/repo")) { /* drain */ }

    const lifecycle = runtimeEvents
      .filter((event) => event.sessionId === parent.id && event.payload.type === "subagent-updated")
      .map((event) => event.payload)
    const taskA = lifecycle.filter((event) => event.type === "subagent-updated" && event.toolCallId === "task-a")
    const taskB = lifecycle.filter((event) => event.type === "subagent-updated" && event.toolCallId === "task-b")
    const reentry = lifecycle.filter((event) => event.type === "subagent-updated" && event.toolCallId === "task-reentry")
    const failed = lifecycle.find((event) => event.type === "subagent-updated" && event.toolCallId === "task-error")

    expect(new Set(taskA.map((event) => event.type === "subagent-updated" && event.subagentKey)).size).toBe(1)
    expect(new Set(taskB.map((event) => event.type === "subagent-updated" && event.subagentKey)).size).toBe(1)
    expect(taskA[0]?.type === "subagent-updated" && taskA[0].subagentKey)
      .not.toBe(taskB[0]?.type === "subagent-updated" && taskB[0].subagentKey)
    expect(taskA).toMatchObject([
      { revision: 1, status: "running", toolCallRole: "spawn", transcript: { kind: "none" } },
      {
        revision: 2,
        status: "completed",
        providerId: "cursor-child-a",
        transcript: { kind: "file", ref: "cursor_transcript_opaque" },
      },
    ])
    expect(taskB).toMatchObject([
      { revision: 1, status: "running", toolCallRole: "spawn", transcript: { kind: "none" } },
      { revision: 2, status: "completed", mode: "background", transcript: { kind: "none" } },
    ])
    expect(reentry).toMatchObject([
      { revision: 1, status: "running", toolCallRole: "interaction", providerId: "cursor-existing-child" },
      { revision: 2, status: "completed", toolCallRole: "interaction", providerId: "cursor-existing-child" },
    ])
    expect(failed).toMatchObject({ status: "failed", transcript: { kind: "none" } })
    expect(failed).not.toHaveProperty("providerId")
    expect(transcriptRegistrations).toEqual([{
      parentSessionId: parent.id,
      providerKind: "cursor-agent",
      filePath: "/provider/private/cursor-child-a.jsonl",
    }])
    expect(transcriptOpens).toEqual([{
      parentSessionId: parent.id,
      handle: "cursor_transcript_opaque",
    }])

    expect(adapter.readHarnessCapabilities().subagents).toBe(true)
    const sessions = store.listSessions("/repo") as Array<{ id: string; parentID?: string }>
    const child = sessions.find((session) => session.parentID === parent.id)
    expect(sessions).toHaveLength(2)
    expect(child).toBeDefined()
    expect(JSON.stringify(store.getMessages(child!.id))).toContain("resolved child transcript")
    expect(JSON.stringify(store.getMessages(parent.id))).toContain('"transcript":"unavailable"')
    expect(JSON.stringify({ runtimeEvents, messages: store.getMessages(parent.id) })).not.toContain("/provider/private")
    expect(JSON.stringify({ runtimeEvents, messages: store.getMessages(parent.id) })).not.toContain("private child transcript")
    expect(JSON.stringify(runtimeEvents)).not.toContain("must-not-adopt")
    adapter.dispose()
  })

  test("fails closed when a registered file transcript cannot be opened", async () => {
    const store = storeRows(createMemoryRuntimeStore())
    const runtimeEvents: RuntimeEventEnvelope[] = []
    const eventHub = createRuntimeEventHub()
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const adapter = new SdkRuntimeAdapter({
      store,
      eventHub,
      driver: (host) => cursorDriver(host.transcriptRegistrar),
      transcriptRegistrar: {
        register: async () => ({ state: "ready", handle: "opaque-without-reader" }),
      },
    })
    const parent = await adapter.createSession("/repo")

    for await (const _ of adapter.sendMessage(parent.id, {
      parts: [{ type: "text", text: "Delegate reviews" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "cursor", modelID: "test" },
    }, "/repo")) { /* drain */ }

    const taskA = runtimeEvents
      .filter((event) => event.sessionId === parent.id && event.payload.type === "subagent-updated")
      .map((event) => event.payload)
      .filter((event) => event.type === "subagent-updated" && event.toolCallId === "task-a")
    expect(taskA.at(-1)).toMatchObject({ transcript: { kind: "none" } })
    expect(taskA.at(-1)).not.toHaveProperty("childSessionId")
    expect(store.listSessions("/repo")).toHaveLength(1)
    adapter.dispose()
  })
})
