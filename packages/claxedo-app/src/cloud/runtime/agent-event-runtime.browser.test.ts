import { describe, expect, test } from "bun:test"
import {
  createAgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import { createAcpEventTranslator } from "@claxedo/agent-event-runtime/harnesses/acp"
import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime/projections/opencode-compat"

describe("agent-event-runtime browser consumption", () => {
  test("imports and replays a small ACP projection under browser conditions", () => {
    const runtime = createAgentEventRuntime({
      provider: "codex-acp",
      threadId: "thread-1",
      adapter: createAcpEventTranslator({ client: "codex-acp" }),
      clock: () => 100,
      createId: () => "id",
    })
    const projection = createOpencodeCompatProjection({
      sessionId: "session-1",
      directory: "/repo",
      assistantMessageId: "assistant-1",
      clock: () => 100,
    })

    const result = runtime.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "hello" },
      },
    })
    const projected = result.events.flatMap((event) => projection.ingest(event))

    expect(result.events.map((event) => event.type)).toEqual(["step-start", "text-delta"])
    expect(projected.map((event) => event.payload.type)).toEqual([
      "message.completed",
      "message.part.updated",
      "message.part.delta",
    ])
  })
})
