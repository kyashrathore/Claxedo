import { describe, expect, test } from "bun:test"
import type { AgentRuntimeStreamEvent, AgentTurnOutcome } from "../index"
import { sessionIdle } from "../compat-events"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload } from "./turn-outcome"

function settle(payloads: AgentRuntimeStreamEvent[]) {
  return payloads.reduce<AgentTurnOutcome | undefined>((outcome, payload) => mergeOutcome(outcome, outcomeFromPayload(payload)), undefined)
}

describe("outcomeFromPayload", () => {
  test("a harness's cancelled terminal records a cancelled turn", () => {
    const payload: AgentRuntimeStreamEvent = { type: "cancelled", sessionId: "session-1" }
    expect(isTerminalRuntimePayload(payload)).toBe(true)
    expect(outcomeFromPayload(payload)).toMatchObject({ status: "cancelled", reason: "abort" })
  })

  test("the idle a cancel emits first never settles the turn as completed", () => {
    expect(settle([
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId: "session-1" },
    ])).toMatchObject({ status: "cancelled", reason: "abort" })
  })

  test("a projected cancelled completion outlasts the idle that follows it", () => {
    expect(settle([
      { type: "message.completed", properties: { sessionID: "session-1", messageID: "msg_1_r", cancelled: true } },
      sessionIdle("session-1"),
    ])).toMatchObject({ status: "cancelled", reason: "abort" })
  })

  test("a turn that ends on finish or a plain completion is completed", () => {
    expect(settle([
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "session-1" },
    ])).toMatchObject({ status: "completed" })
    expect(settle([
      { type: "message.completed", properties: { sessionID: "session-1", messageID: "msg_1_r" } },
      sessionIdle("session-1"),
    ])).toMatchObject({ status: "completed" })
  })
})
