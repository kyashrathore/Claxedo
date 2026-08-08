import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import { createOpencodeCompatProjection } from "../../projections/opencode-compat"
import { replayRuntimeEvents } from "../../test-utils/replay"
import { createAcpEventTranslator } from "./event-translator"

describe("ACP frozen compat output", () => {
  test("maps a representative Codex ACP trace to the pre-extraction compat shape", () => {
    const runtime = createAgentEventRuntime({
      harness: "codex-acp",
      threadId: "thread-1",
      adapter: createAcpEventTranslator({ client: "codex-acp" }),
      clock: () => 0,
      createId: () => "id",
    })
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
      clock: () => 100,
    })

    const runtimeEvents = replayRuntimeEvents(runtime, [
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message-1",
          content: { type: "text", text: "hello" },
        },
      },
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "tool_call",
          toolCallId: "permission-1",
          title: "Permission",
          rawInput: { tool: "shell", reason: "Needs access", scopes: ["/repo"] },
        },
      },
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "usage_update",
          size: 100,
          used: 25,
        },
      },
    ])

    expect(runtimeEvents.flatMap((event) => projection.ingest(event))).toEqual([
      {
        directory: "/repo",
        payload: {
          type: "message.completed",
          properties: { sessionID: "session-1", messageID: "assistant-1" },
        },
      },
      {
        directory: "/repo",
        payload: {
          id: "message.part.updated:message-1:000000_message-1-text",
          type: "message.part.updated",
          properties: {
            sessionID: "session-1",
            time: 100,
            part: {
              id: "000000_message-1-text",
              sessionID: "session-1",
              messageID: "message-1",
              type: "text",
              text: "",
            },
          },
        },
      },
      {
        directory: "/repo",
        payload: {
          id: "message.part.delta:message-1:000000_message-1-text",
          type: "message.part.delta",
          properties: {
            sessionID: "session-1",
            messageID: "message-1",
            partID: "000000_message-1-text",
            field: "text",
            delta: "hello",
          },
        },
      },
      {
        directory: "/repo",
        payload: {
          id: "permission.asked:permission-1",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "session-1",
            permission: "shell",
            patterns: ["/repo"],
            metadata: {},
            always: ["/repo"],
          },
        },
      },
      {
        directory: "/repo",
        payload: {
          type: "session.usage",
          properties: {
            sessionID: "session-1",
            messageID: "message-1",
            contextSize: 100,
            contextUsed: 25,
          },
        },
      },
    ])
  })

  test("preserves ACP-only surfaces in runtime and degrades compat with diagnostics", () => {
    const runtime = createAgentEventRuntime({
      harness: "codex-acp",
      threadId: "thread-1",
      adapter: createAcpEventTranslator({ client: "codex-acp", preserveUserMessageChunks: true }),
      clock: () => 0,
      createId: () => "id",
    })
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
      clock: () => 100,
    })

    const runtimeEvents = replayRuntimeEvents(runtime, [
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-message-1",
          content: { type: "text", text: "user says hi" },
        },
      },
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "create_plan", description: "Create a plan" }],
        },
      },
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "session_info_update",
          title: null,
          updatedAt: "2026-06-16T00:00:00.000Z",
        },
      },
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Tool",
          kind: "execute",
          status: "pending",
        },
      },
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          content: [
            { type: "content", content: { type: "text", text: "tool text" } },
            { type: "content", content: { type: "image", mimeType: "image/png", data: "iVBORw0" } },
          ],
        },
      },
      {
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "agent_thought_chunk",
          messageId: "message-1",
          content: { type: "audio", mimeType: "audio/wav", data: "AAAA" },
        },
      },
    ])
    const compat = runtimeEvents.flatMap((event) => projection.ingest(event))
    const payloads = compat.map((event) => event.payload)

    expect(runtimeEvents.map((event) => event.type)).toEqual([
      "user-message-delta",
      "available-commands-update",
      "session-info",
      "tool-status",
      "tool-start",
      "tool-input",
      "tool-status",
      "tool-content",
      "tool-content",
      "thinking-audio-delta",
    ])
    expect(payloads.filter((payload) => payload.type === "runtime.diagnostic")).toMatchObject([
      {
        properties: {
          eventType: "user-message-delta",
          code: "projection.opencode_compat.lossy_runtime_event",
        },
      },
      {
        properties: {
          eventType: "available-commands-update",
          code: "projection.opencode_compat.lossy_runtime_event",
        },
      },
      {
        properties: {
          eventType: "tool-content",
          code: "projection.opencode_compat.lossy_runtime_event",
        },
      },
      {
        properties: {
          eventType: "thinking-audio-delta",
          code: "projection.opencode_compat.lossy_runtime_event",
        },
      },
    ])
    expect(payloads.find((payload) => payload.type === "session.updated")).toMatchObject({
      properties: {
        info: {
          title: "",
          time: {
            created: Date.parse("2026-06-16T00:00:00.000Z"),
            updated: Date.parse("2026-06-16T00:00:00.000Z"),
          },
        },
      },
    })
    expect(payloads.filter((payload) => payload.type === "message.part.updated")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            part: expect.objectContaining({
              callID: "tool-1",
              state: expect.objectContaining({
                status: "pending",
              }),
            }),
          }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            part: expect.objectContaining({
              callID: "tool-1",
              metadata: expect.objectContaining({
                acp: expect.objectContaining({
                  content: expect.arrayContaining([
                    expect.objectContaining({
                      content: expect.objectContaining({ text: "tool text" }),
                    }),
                  ]),
                }),
              }),
            }),
          }),
        }),
      ]),
    )
  })
})
