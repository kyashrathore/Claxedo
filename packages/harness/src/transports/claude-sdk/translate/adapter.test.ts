import { describe, expect, test } from "bun:test"
import { claudeRuntime as runtime } from "../test-support/runtime"

describe("claudeSdkAdapter", () => {
  test("stream content with nothing to show is ignored by name", () => {
    const agent = runtime()
    const stream = (event: Record<string, unknown>) => agent.ingest({ source: "claude.sdk.message", payload: { type: "stream_event", event } }).events
    expect(stream({ type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "webpage", url: "https://example.com" } } })).toEqual([])
    expect(stream({ type: "content_block_start", index: 0, content_block: { type: "fallback" } })).toEqual([])
    expect(stream({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "x" } })).toEqual([])
  })
})
