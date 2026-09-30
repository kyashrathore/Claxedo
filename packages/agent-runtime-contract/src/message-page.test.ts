import { describe, expect, test } from "bun:test"
import { AgentMessagePageError, decodeMessagePageCursor, encodeMessagePageCursor, parseMessagePageQuery, projectLatestSurfaceMessage, projectLatestSurfaceMessages } from "./message-page"

describe("latest-surface first-paint projection", () => {
  test("keeps the envelope whole and every text part, and drops every other part", () => {
    const text = { id: "text", type: "text", text: "complete prompt", metadata: { canonical: true } }
    const message = {
      info: {
        id: "user",
        role: "user",
        time: { created: 1 },
        summary: { title: "large summary" },
        system: "large system prompt",
        tools: { read: true },
      },
      parts: [text, { id: "file", type: "file", url: "data:large" }],
      harnessPayload: { preserved: true },
    }

    expect(projectLatestSurfaceMessage(message)).toEqual({ ...message, parts: [text] })
    expect(message.parts).toHaveLength(2)
  })

  test("keeps an assistant error and a text of any size, whole, and omits tool and reasoning parts", () => {
    const info = {
      id: "assistant",
      role: "assistant",
      parentID: "user",
      time: { created: 2, completed: 3 },
      error: { name: "ProviderError", data: { body: "e".repeat(64 * 1024) } },
    }
    const narration = { id: "narration", type: "text", text: "Let me look." }
    const answer = { id: "answer", type: "text", text: "a".repeat(200 * 1024) }

    expect(projectLatestSurfaceMessage({
      info,
      parts: [
        narration,
        { id: "tool", type: "tool", tool: "bash", state: { status: "completed", output: "o".repeat(1024) } },
        { id: "reasoning", type: "reasoning", text: "thinking" },
        answer,
      ],
    })).toEqual({ info, parts: [narration, answer] })
  })

  test("projects every message in canonical order", () => {
    const user = { info: { id: "user", role: "user" }, parts: [{ id: "u", type: "text", text: "hi" }] }
    const assistant = {
      info: { id: "assistant", role: "assistant" },
      parts: Array.from({ length: 40 }, (_, index) => ({ id: `a-${index}`, type: "text", text: `${index}` })),
    }
    const projected = projectLatestSurfaceMessages([user, assistant])
    expect(projected[0]).toEqual(user)
    expect(projected[1]?.parts.map((part) => (part as { id: string }).id)).toEqual(assistant.parts.map((part) => part.id))
  })
})

describe("message page input", () => {
  test("accepts the semantic views by themselves, and a whole turn before a cursor", () => {
    expect(parseMessagePageQuery(undefined, undefined, "latest-turn")).toEqual({ view: "latest-turn" })
    expect(parseMessagePageQuery(undefined, undefined, "latest-surface")).toEqual({ view: "latest-surface" })
    expect(parseMessagePageQuery(undefined, "cursor", "latest-turn")).toEqual({ view: "latest-turn", before: "cursor" })
  })

  test("rejects unknown or mixed semantic views", () => {
    expect(() => parseMessagePageQuery(undefined, undefined, "latest-message")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageQuery("20", undefined, "latest-turn")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageQuery(undefined, "", "latest-turn")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageQuery(undefined, "cursor", "latest-surface")).toThrow(AgentMessagePageError)
    expect(() => parseMessagePageQuery("20", undefined, "latest-surface")).toThrow(AgentMessagePageError)
  })
})

describe("message page cursor", () => {
  test("reads back the ordinal it was minted with, for its own producer and session only", () => {
    const cursor = encodeMessagePageCursor("wrmp1:", "ses_a", 42)
    expect(cursor).toMatch(/^wrmp1:[A-Za-z0-9_-]+$/)
    expect(decodeMessagePageCursor("wrmp1:", "ses_a", cursor)).toBe(42)
    for (const [prefix, sessionId, input] of [
      ["cspm1:", "ses_a", cursor],
      ["wrmp1:", "ses_b", cursor],
      ["wrmp1:", "ses_a", "wrmp1:"],
      ["wrmp1:", "ses_a", "wrmp1:not+base64url"],
      ["wrmp1:", "ses_a", encodeMessagePageCursor("wrmp1:", "ses_a", -1)],
    ] as const) {
      expect(() => decodeMessagePageCursor(prefix, sessionId, input)).toThrow(new AgentMessagePageError(400, "Invalid message page cursor"))
    }
  })
})
