import { describe, expect, test } from "bun:test"
import { assistantMessageIdForTurn, createMessageIds, userMessageIdForAssistantReply } from "./turn-message-ids"

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

test("minted message ids sort in the order they were minted, within one millisecond and across later ones", () => {
  let now = 1_790_702_067_619
  const next = createMessageIds(() => now)
  const minted = [next(), next(), next()]
  now += 1
  minted.push(next())
  now += 60_000
  minted.push(next())
  expect([...minted].reverse().sort()).toEqual(minted)
})
