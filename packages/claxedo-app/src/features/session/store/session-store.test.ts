import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { idleSessionStatus, isSessionTurnActive, mergeBusySessionStatus, pickSessionPermissions, pickSessionQuestions } from "./session-store"

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy" }
const retry: SessionStatus = { type: "retry", attempt: 1, message: "retrying", next: 0 }
const recovering: SessionStatus = { type: "recovering", kind: "process_restart", message: "stale" }

function permission(id: string, sessionID: string): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
  }
}

function question(id: string, sessionID: string): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [],
  }
}

describe("session store helpers", () => {
  test("preserves optimistic busy over server idle", () => {
    expect(mergeBusySessionStatus(busy, idle)).toEqual({ type: "busy" })
  })

  test("falls back to server state when not preserving local busy", () => {
    expect(mergeBusySessionStatus(undefined, busy)).toEqual({ type: "busy" })
    expect(mergeBusySessionStatus(retry, idle)).toEqual({ type: "idle" })
    expect(mergeBusySessionStatus(busy, idle, false)).toEqual({ type: "idle" })
    expect(idleSessionStatus).toEqual({ type: "idle" })
  })

  test("filters permission and question lists per session", () => {
    expect(pickSessionPermissions([
      permission("b", "ses_2"),
      permission("a", "ses_1"),
      permission("c", "ses_1"),
    ], "ses_1").map((item) => item.id)).toEqual(["a", "c"])

    expect(pickSessionQuestions([
      question("b", "ses_2"),
      question("a", "ses_1"),
    ], "ses_1").map((item) => item.id)).toEqual(["a"])
  })

  test("does not infer active turns from idle status alone", () => {
    expect(isSessionTurnActive({
      status: idle,
    })).toBe(false)
  })

  test("recovering status is not an active cancellable turn", () => {
    expect(isSessionTurnActive({
      status: recovering,
    })).toBe(false)
  })

  test("detects active turns from pending interactions", () => {
    expect(isSessionTurnActive({
      status: idle,
      permissions: [permission("perm_1", "ses_1")],
    })).toBe(true)
    expect(isSessionTurnActive({
      status: idle,
      questions: [question("question_1", "ses_1")],
    })).toBe(true)
  })
})
