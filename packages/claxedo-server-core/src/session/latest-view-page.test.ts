import { describe, expect, it } from "vitest"
import { InvalidStoredMessage, storedTurn } from "./latest-view-page"

describe("stored turn admission", () => {
  const message = { info: { id: "m1", role: "user", sessionID: "s1" }, parts: [] }

  it("preserves canonical messages, order, and the older-turn cursor", () => {
    const second = { ...message, info: { ...message.info, id: "m2", role: "assistant" } }
    const page = storedTurn({ messages: [message, second], nextCursor: "d1sm1:older" })
    expect(page.messages).toEqual([message, second])
    expect(page.messages[0]).toBe(message)
    expect(page.nextCursor).toBe("d1sm1:older")
    expect(storedTurn({ messages: [] })).toEqual({ messages: [] })
  })

  it.each([null, {}, { ...message, parts: [{ type: "unknown-part" }] }, { info: { id: "m2", role: "user" }, parts: [] }])(
    "refuses a malformed stored snapshot instead of dropping or repairing it",
    (invalid) => {
      expect(() => storedTurn({ messages: [message, invalid] })).toThrow(InvalidStoredMessage)
      expect(() => storedTurn({ messages: [message, invalid] })).toThrow("message 1")
    },
  )
})
