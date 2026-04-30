import { describe, expect, test } from "bun:test"
import { idleSessionStatus, isSessionTurnActive, mergeBusySessionStatus, pickSessionPermissions, pickSessionQuestions } from "./session-store"

describe("session store helpers", () => {
  test("preserves optimistic busy over server idle", () => {
    expect(mergeBusySessionStatus({ type: "busy" } as any, { type: "idle" } as any)).toEqual({ type: "busy" })
  })

  test("falls back to server state when not preserving local busy", () => {
    expect(mergeBusySessionStatus(undefined, { type: "busy" } as any)).toEqual({ type: "busy" })
    expect(mergeBusySessionStatus({ type: "retry" } as any, { type: "idle" } as any)).toEqual({ type: "idle" })
    expect(mergeBusySessionStatus({ type: "busy" } as any, { type: "idle" } as any, false)).toEqual({ type: "idle" })
    expect(idleSessionStatus).toEqual({ type: "idle" })
  })

  test("filters permission and question lists per session", () => {
    expect(pickSessionPermissions([
      { id: "b", sessionID: "ses_2" },
      { id: "a", sessionID: "ses_1" },
      { id: "c", sessionID: "ses_1" },
    ] as any, "ses_1").map((item) => item.id)).toEqual(["a", "c"])

    expect(pickSessionQuestions([
      { id: "b", sessionID: "ses_2" },
      { id: "a", sessionID: "ses_1" },
    ] as any, "ses_1").map((item) => item.id)).toEqual(["a"])
  })

  test("does not infer active turns from incomplete assistant message history", () => {
    expect(isSessionTurnActive({
      status: { type: "idle" } as any,
      messages: [
        { id: "msg_user", role: "user", time: { created: 1 } },
        { id: "msg_assistant", role: "assistant", time: { created: 2 } },
      ] as any,
    })).toBe(false)
  })

  test("recovering status is not an active cancellable turn", () => {
    expect(isSessionTurnActive({
      status: { type: "recovering", kind: "process_restart", message: "stale" } as any,
      messages: [{ id: "msg_assistant", role: "assistant", time: { created: 2 } }] as any,
    })).toBe(false)
  })

  test("detects active turns from pending interactions", () => {
    expect(isSessionTurnActive({
      status: { type: "idle" } as any,
      permissions: [{ id: "perm_1", sessionID: "ses_1" }] as any,
    })).toBe(true)
    expect(isSessionTurnActive({
      status: { type: "idle" } as any,
      questions: [{ id: "question_1", sessionID: "ses_1" }] as any,
    })).toBe(true)
  })
})
