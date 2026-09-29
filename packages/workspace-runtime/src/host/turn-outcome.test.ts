import { describe, expect, test } from "bun:test"
import type { AgentRuntimeStreamEvent } from "./contracts"
import type { AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import { isTerminalRuntimePayload, mergeOutcome, outcomeFromPayload } from "./turn-outcome"
import { sessionIdle } from "../projection/presentation-events"

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

  test("a harness's own error class rides the failed turn, through the session error placeholder before it", () => {
    expect(settle([
      { type: "session-status", status: "error" },
      { type: "error", error: "Claude assistant message failed: rate_limit", errorClass: "usage_limit" },
    ])).toMatchObject({ status: "failed", error: "Claude assistant message failed: rate_limit", errorClass: "usage_limit" })
    expect(outcomeFromPayload({ type: "error", error: "sandbox denied" })).not.toHaveProperty("errorClass")
  })

  test("a projected session error keeps the class it carries and drops one outside the vocabulary", () => {
    const projected = (firstTurnErrorClass: string): AgentRuntimeStreamEvent => ({
      id: "session.error:session-1",
      type: "session.error",
      properties: { sessionID: "session-1", error: { name: "UnknownError", data: { message: "429", firstTurnErrorClass } } },
    })
    expect(outcomeFromPayload(projected("rate_limit"))).toMatchObject({ status: "failed", error: "429", errorClass: "rate_limit" })
    expect(outcomeFromPayload(projected("throttled"))).not.toHaveProperty("errorClass")
  })

  test("the account a failed turn ran on rides its outcome from the event and from a projected session error", () => {
    const account = { kind: "stored", harnessId: "claude", credentialId: "cred-1", providerId: "claude-sdk", label: "contactyash" } as const
    expect(outcomeFromPayload({ type: "error", error: "429", account })).toMatchObject({ status: "failed", account })
    expect(outcomeFromPayload({
      id: "session.error:session-1",
      type: "session.error",
      properties: { sessionID: "session-1", error: { name: "UnknownError", data: { message: "429", account } } },
    })).toMatchObject({ status: "failed", account })
    expect(outcomeFromPayload({
      id: "session.error:session-1",
      type: "session.error",
      properties: { sessionID: "session-1", error: { name: "UnknownError", data: { message: "429", account: { kind: "stored" } } } },
    })).not.toHaveProperty("account")
  })
})
