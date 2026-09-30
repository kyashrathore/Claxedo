import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

function started(id: string) {
  const agent = runtime()
  agent.ingest({ source: "claude.sdk.message", payload: { type: "stream_event", event: { type: "message_start", message: { id, content: [] } } } })
  return agent
}

describe("claudeSdkAdapter", () => {
  test("preserves provider error explanation and recovery guidance", () => {
    const explanation = "API Error: This request was blocked. Try a new session or change your model."
    const agent = runtime()
    const failed = agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant", error: "invalid_request",
        message: { content: [{ type: "text", text: explanation }] },
      },
    }).events
    expect(failed).toEqual([])
    const events = agent.ingest({ source: "claude.sdk.message", payload: { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: explanation } }).events
    expect(events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: `Claude assistant message failed: invalid_request\n${explanation}` },
    ])
    expect(events.some((event) => event.type === "text-delta")).toBe(false)
  })

  test("maps text deltas and suppresses duplicate assistant snapshots", () => {
    const agent = started("message-1")

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: "Hi" }])

    expect(agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        uuid: "assistant-1",
        message: { id: "message-1", content: [{ type: "text", text: "Hi" }] },
      },
    }).events).toEqual([])
  })

  test("keeps the active assistant text stream without duplicating snapshots", () => {
    const first = started("message-1")
    first.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
      },
    })

    expect(first.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        uuid: "assistant-1",
        message: { id: "message-1", content: [{ type: "text", text: "Hi there" }] },
      },
    }).events).toMatchObject([{ type: "text-delta", delta: " there" }])
  })
})
