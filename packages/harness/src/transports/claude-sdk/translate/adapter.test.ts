import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
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
})
