/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "@/server"
import type { SessionRowView, SessionStatusView } from "@/session"
import { sessionActivity, unseenOutcome } from "./activity"

function row(status: SessionStatusView, waitingOnUser = false): SessionRowView {
  return {
    ref: { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") },
    title: "Session",
    createdAt: 1,
    updatedAt: 1,
    status,
    waitingOnUser,
    pending: false,
    settled: false,
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

test("unseen outcome: a finished or failed turn ending after the reader's seen mark, on a session that is not running or waiting", () => {
  const ended = (status: "completed" | "failed" | "cancelled", seenAt?: number, live: SessionStatusView = { kind: "idle" }, waiting = false) =>
    unseenOutcome({ ...row(live, waiting), lastTurn: { status, completedAt: 50 }, ...(seenAt === undefined ? {} : { seenAt }) })
  expect(ended("completed")).toBe("finished")
  expect(ended("failed", 49)).toBe("failed")
  expect(ended("completed", 50)).toBeUndefined()
  expect(ended("cancelled")).toBeUndefined()
  expect(ended("completed", undefined, { kind: "working" })).toBeUndefined()
  expect(ended("completed", undefined, { kind: "runningInBackground" })).toBeUndefined()
  expect(ended("failed", undefined, { kind: "idle" }, true)).toBeUndefined()
  expect(unseenOutcome(row({ kind: "idle" }))).toBeUndefined()
})
