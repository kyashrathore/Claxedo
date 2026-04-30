import { describe, expect, it } from "bun:test"
import type { AgentEvent } from "./index"
import { translateAgentEventToCompat } from "./translate-agent-event-to-compat"

function ctx() {
  return {
    sessionId: "sess-1",
    directory: "/workspace",
    assistantMsgId: "asm-1",
    accumulatedText: "hello",
    accumulatedThinkingText: "thinking",
    toolNamesByCallId: {},
    partIdMap: {},
    toolInputsByCallId: {},
    toolMetadataByCallId: {},
    toolStatusByCallId: {},
    textPartSeq: 0,
    reasoningPartSeq: 0,
    splitText: false,
    splitReasoning: false,
  }
}

describe("translateAgentEventToCompat", () => {
  it("maps text deltas through the shared compat layer", () => {
    const event: AgentEvent = { type: "text-delta", delta: " world" }
    const out = translateAgentEventToCompat(event, ctx())
    expect(out).toHaveLength(2)
    expect(out[0].payload.type).toBe("message.part.updated")
    expect(out[1].payload).toMatchObject({
      type: "message.part.delta",
      properties: {
        sessionID: "sess-1",
        partID: "000000_asm-1-text",
        delta: " world",
      },
    })
  })

  it("maps permission requests without backend-specific logic", () => {
    const event: AgentEvent = {
      type: "permission-request",
      requestId: "perm-1",
      tool: "read",
      paths: ["/tmp/file.ts"],
    }
    const out = translateAgentEventToCompat(event, ctx())
    expect(out).toHaveLength(1)
    expect(out[0].payload).toMatchObject({
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "sess-1",
        permission: "read",
        patterns: ["/tmp/file.ts"],
        metadata: {},
        always: ["/tmp/file.ts"],
      },
    })
  })
})
