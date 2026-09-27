import { describe, expect, test } from "bun:test"
import { assistantMessageIdForTurn, userMessageIdForAssistantReply } from "./turn-message-ids"

describe("turn message ids", () => {
  test("a minted reply id resolves back to the message it answers", () => {
    expect(userMessageIdForAssistantReply(assistantMessageIdForTurn("msg_1"))).toBe("msg_1")
  })

  test("an id outside the convention names no user message", () => {
    expect(userMessageIdForAssistantReply("msg_engine_chose_this")).toBeUndefined()
    // A bare suffix is not a reply either: there is no id left to answer.
    expect(userMessageIdForAssistantReply("_r")).toBeUndefined()
  })

  test("a reply id is recovered whole, not by trimming a fixed length", () => {
    expect(userMessageIdForAssistantReply(assistantMessageIdForTurn("msg_ends_with_r"))).toBe("msg_ends_with_r")
  })
})
