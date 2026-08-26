import { describe, expect, test } from "bun:test"
import { estimateConversationMemory } from "./conversation-memory"

describe("conversation memory estimates", () => {
  test("separates image, compaction, and remaining chat payload", () => {
    const messages = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          { type: "text", content: "hello" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(300) } },
          { type: "compaction", summary: "condensed history" },
        ],
      },
    ]

    const result = estimateConversationMemory(messages)

    expect(result.imageBytes).toBeGreaterThanOrEqual(302)
    expect(result.compactionBytes).toBeGreaterThan("condensed history".length)
    expect(result.chatBytes).toBeGreaterThan("hello".length)
    expect(result.totalBytes).toBe(result.chatBytes + result.imageBytes + result.compactionBytes)
  })

  test("does not loop or count a shared object twice", () => {
    const metadata: Record<string, unknown> = { text: "shared" }
    metadata.self = metadata
    const result = estimateConversationMemory([{ id: "msg", role: "assistant", parts: [], metadata }])
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(result.totalBytes).toBeLessThan(1_000)
  })
})
