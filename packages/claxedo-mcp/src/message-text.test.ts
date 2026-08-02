import { describe, test, expect } from "vitest"
import { formatSessionMessages, messageText, resolveResponseText, type SessionMessage } from "./message-text"

describe("messageText", () => {
  test("joins non-ignored text parts", () => {
    const message: SessionMessage = {
      parts: [
        { type: "text", text: "hello" },
        { type: "text", text: "world", ignored: true },
        { type: "tool", text: "ignored kind" },
        { type: "text", text: "again" },
      ],
    }
    expect(messageText(message)).toBe("hello\nagain")
  })

  test("returns empty string when there are no parts", () => {
    expect(messageText({})).toBe("")
  })
})

describe("formatSessionMessages", () => {
  test("formats role, id, and body", () => {
    const messages: SessionMessage[] = [
      { info: { id: "msg_1", role: "assistant" }, parts: [{ type: "text", text: "hi there" }] },
    ]
    expect(formatSessionMessages(messages)).toBe("1. assistant [msg_1]\nhi there")
  })
})

describe("resolveResponseText", () => {
  test("returns the initial message text without fetching when already present", async () => {
    const result: SessionMessage = { info: { id: "msg_1" }, parts: [{ type: "text", text: "already here" }] }
    let fetchCalls = 0
    const text = await resolveResponseText(result, async () => {
      fetchCalls++
      return []
    })
    expect(text).toBe("already here")
    expect(fetchCalls).toBe(0)
  })

  test("returns empty string without fetching when the message has no id", async () => {
    const result: SessionMessage = { parts: [] }
    let fetchCalls = 0
    const text = await resolveResponseText(result, async () => {
      fetchCalls++
      return []
    })
    expect(text).toBe("")
    expect(fetchCalls).toBe(0)
  })

  // Regression test for the dead `GET /session/:id/message/:messageId` route:
  // the workspace-runtime only exposes the list route
  // (`GET /session/:id/message`), so the fallback must re-fetch the list and
  // find the message by id instead of requesting a per-id URL that 404s.
  test("falls back to scanning the message list by id when initial text is empty", async () => {
    const result: SessionMessage = { info: { id: "msg_2" }, parts: [] }
    const messages: SessionMessage[] = [
      { info: { id: "msg_1" }, parts: [{ type: "text", text: "not this one" }] },
      { info: { id: "msg_2" }, parts: [{ type: "text", text: "settled text" }] },
    ]
    let fetchCalls = 0
    const text = await resolveResponseText(result, async () => {
      fetchCalls++
      return messages
    })
    expect(text).toBe("settled text")
    expect(fetchCalls).toBe(1)
  })

  test("returns empty string when no message in the list matches the id", async () => {
    const result: SessionMessage = { info: { id: "msg_missing" }, parts: [] }
    const text = await resolveResponseText(result, async () => [
      { info: { id: "msg_1" }, parts: [{ type: "text", text: "irrelevant" }] },
    ])
    expect(text).toBe("")
  })

  test("propagates a fetch failure (e.g. a 404 from a dead per-id route) instead of swallowing it", async () => {
    const result: SessionMessage = { info: { id: "msg_2" }, parts: [] }
    await expect(
      resolveResponseText(result, async () => {
        throw new Error("HTTP 404")
      }),
    ).rejects.toThrow("HTTP 404")
  })
})
