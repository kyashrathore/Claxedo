import { describe, expect, test } from "bun:test"
import { Timeline } from "./message-timeline.data"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

function assistantMessage(overrides: Record<string, unknown> = {}): AssistantMessage {
  return {
    id: "a1",
    sessionID: "ses_test",
    role: "assistant",
    time: { created: 1_000 },
    ...overrides,
  } as AssistantMessage
}

describe("Timeline.turnInterrupted", () => {
  test("native harness abort: MessageAbortedError on any message wins", () => {
    const messages = [
      assistantMessage({ id: "a1", error: { name: "MessageAbortedError" }, time: { created: 1_000 } }),
      assistantMessage({ id: "a2", time: { created: 2_000, completed: 3_000 } }),
    ]
    expect(Timeline.turnInterrupted(messages)).toBe(true)
  })

  test("SDK harness abort: canonical cancelled outcome matches the assistant message", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages, {
      status: "cancelled",
      completedAt: 2_000,
      assistantMessageId: "a1",
    })).toBe(true)
  })

  test("an unsettled message is not interruption evidence", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages)).toBe(false)
    expect(Timeline.turnInterrupted(messages, {
      status: "completed",
      completedAt: 2_000,
      assistantMessageId: "a1",
    })).toBe(false)
  })

  test("a cancelled outcome for another turn does not mark this message interrupted", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages, {
      status: "cancelled",
      completedAt: 2_000,
      assistantMessageId: "a2",
    })).toBe(false)
  })

  test("a settled turn is not interrupted", () => {
    expect(Timeline.turnInterrupted([assistantMessage({ time: { created: 1_000, completed: 2_000 } })])).toBe(
      false,
    )
  })

  test("Pi-style failures (error + completed stamped) fall through to the error path, not interrupted", () => {
    const messages = [
      assistantMessage({ error: { name: "UnknownError" }, time: { created: 1_000, completed: 2_000 } }),
    ]
    expect(Timeline.turnInterrupted(messages)).toBe(false)
  })

  test("a turn with no assistant messages is not interrupted", () => {
    expect(Timeline.turnInterrupted([], {
      status: "cancelled",
      completedAt: 2_000,
      assistantMessageId: "a1",
    })).toBe(false)
  })
})
