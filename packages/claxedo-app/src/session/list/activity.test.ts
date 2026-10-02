/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "@/server"
import type { SessionRowView, SessionStatusView } from "@/session"
import { sessionActivity } from "./activity"

function row(status: SessionStatusView, waitingOnUser = false): SessionRowView {
  return {
    ref: { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") },
    title: "Session",
    createdAt: 1,
    updatedAt: 1,
    status,
    waitingOnUser,
    pending: false,
  }
}

test("session activity: running in background is its own activity, apart from a running turn and from idle", () => {
  expect(sessionActivity(row({ kind: "runningInBackground" }))).toBe("background")
  expect(sessionActivity(row({ kind: "working" }))).toBe("working")
  expect(sessionActivity(row({ kind: "retrying", attempt: 1, message: "later", nextAt: 2 }))).toBe("working")
  expect(sessionActivity(row({ kind: "idle" }))).toBe("idle")
  expect(sessionActivity(row({ kind: "interrupted" }))).toBe("interrupted")
  expect(sessionActivity(row({ kind: "unknown" }))).toBe("idle")
})

test("session activity: a wait on the reader outranks everything", () => {
  expect(sessionActivity(row({ kind: "runningInBackground" }, true))).toBe("waiting")
  const failed = { kind: "failed", error: new Error("boom") } as unknown as SessionStatusView
  expect(sessionActivity(row(failed))).toBe("failed")
})
