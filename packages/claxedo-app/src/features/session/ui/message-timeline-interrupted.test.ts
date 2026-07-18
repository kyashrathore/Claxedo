import { describe, expect, test } from "bun:test"
import { Timeline } from "./message-timeline.data"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

/**
 * Only the opencode-native harness stamps MessageAbortedError on abort. SDK-runtime
 * harnesses (codex/claude/cursor/ACP) emit no error and skip the finish event, leaving the
 * turn's last assistant message with no completed time and no error — detecting that shape
 * once the turn is no longer live is the only abort signal they give us. These tests pin
 * both detection paths plus the states that must NOT read as interrupted.
 */
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
  test("native harness abort: MessageAbortedError on any message wins regardless of status", () => {
    const messages = [
      assistantMessage({ id: "a1", error: { name: "MessageAbortedError" }, time: { created: 1_000 } }),
      assistantMessage({ id: "a2", time: { created: 2_000, completed: 3_000 } }),
    ]
    expect(Timeline.turnInterrupted(messages, "busy", true)).toBe(true)
    expect(Timeline.turnInterrupted(messages, "idle", false)).toBe(true)
  })

  test("SDK harness abort: idle turn whose last message never settled", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages, "idle", false)).toBe(true)
    expect(Timeline.turnInterrupted(messages, "idle", true)).toBe(true)
  })

  test("a turn still streaming or retrying is not interrupted", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages, "busy", true)).toBe(false)
    expect(Timeline.turnInterrupted(messages, "retry", true)).toBe(false)
  })

  test("an unsettled older turn reads as interrupted even while another turn runs", () => {
    const messages = [assistantMessage()]
    expect(Timeline.turnInterrupted(messages, "busy", false)).toBe(true)
  })

  test("a settled turn is not interrupted", () => {
    expect(Timeline.turnInterrupted([assistantMessage({ time: { created: 1_000, completed: 2_000 } })], "idle", false)).toBe(
      false,
    )
  })

  test("Pi-style failures (error + completed stamped) fall through to the error path, not interrupted", () => {
    const messages = [
      assistantMessage({ error: { name: "UnknownError" }, time: { created: 1_000, completed: 2_000 } }),
    ]
    expect(Timeline.turnInterrupted(messages, "idle", false)).toBe(false)
  })

  test("a turn with no assistant messages is not interrupted", () => {
    expect(Timeline.turnInterrupted([], "idle", false)).toBe(false)
  })
})
