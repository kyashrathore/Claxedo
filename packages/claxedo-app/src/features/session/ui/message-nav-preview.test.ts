import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { messageNavCurrentID, messageNavPreview, messageNavVisible } from "./message-nav-preview"

const text = (id: string, messageID: string, value: string, options?: { synthetic?: boolean; ignored?: boolean }) =>
  ({
    id,
    sessionID: "session",
    messageID,
    type: "text" as const,
    text: value,
    ...options,
  }) satisfies Part

describe("message nav preview", () => {
  test("appears only after ten turns", () => {
    expect(messageNavVisible(10)).toBe(false)
    expect(messageNavVisible(11)).toBe(true)
  })

  test("tracks the turn crossing the viewport reading line", () => {
    const turns = [
      { id: "one", start: 0 },
      { id: "two", start: 240 },
      { id: "three", start: 520 },
    ]

    expect(messageNavCurrentID(turns, 519)).toBe("two")
    expect(messageNavCurrentID(turns, 520)).toBe("three")
  })

  test("combines normalized user and assistant text across provider messages", () => {
    const parts = {
      user: [text("u1", "user", "  Fix\n the timeline  ")],
      assistant1: [text("a1", "assistant1", "I found the cause.")],
      assistant2: [text("a2", "assistant2", "Here is the fix.")],
    }

    expect(
      messageNavPreview({
        userMessageID: "user",
        assistantMessageIDs: ["assistant1", "assistant2"],
        getParts: (id) => parts[id as keyof typeof parts] ?? [],
      }),
    ).toEqual({
      user: "Fix the timeline",
      assistant: "I found the cause. Here is the fix.",
    })
  })

  test("does not leak synthetic or ignored harness context into the preview", () => {
    const parts = [
      text("context", "user", "hidden context", { synthetic: true }),
      text("ignored", "user", "ignored", { ignored: true }),
    ]

    expect(
      messageNavPreview({
        userMessageID: "user",
        assistantMessageIDs: [],
        getParts: () => parts,
      }),
    ).toEqual({ user: undefined, assistant: undefined })
  })
})
