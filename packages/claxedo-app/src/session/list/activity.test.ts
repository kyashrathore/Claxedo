/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "@/server"
import type { SessionRowView, SessionStatusView } from "@/session"
import { sessionActivity } from "./activity"

function row(status: SessionStatusView, facts: { waitingOnUser?: boolean; backgroundWork?: boolean } = {}): SessionRowView {
  return {
    ref: { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") },
    title: "Session",
    createdAt: 1,
    updatedAt: 1,
    status,
    waitingOnUser: facts.waitingOnUser ?? false,
    backgroundWork: facts.backgroundWork ?? false,
    pending: false,
  }
}

test("session activity: a session whose turn ended while background work runs is still working", () => {
  expect(sessionActivity(row({ kind: "idle" }, { backgroundWork: true }))).toBe("working")
  expect(sessionActivity(row({ kind: "unknown" }, { backgroundWork: true }))).toBe("working")
  expect(sessionActivity(row({ kind: "idle" }))).toBe("idle")
})

test("session activity: a wait on the reader outranks everything, and a failed turn stays failed beside background work", () => {
  expect(sessionActivity(row({ kind: "working" }, { waitingOnUser: true, backgroundWork: true }))).toBe("waiting")
  expect(sessionActivity(row({ kind: "retrying", attempt: 1, message: "later", nextAt: 2 }))).toBe("working")
  const failed = { kind: "failed", error: new Error("boom") } as unknown as SessionStatusView
  expect(sessionActivity(row(failed, { backgroundWork: true }))).toBe("failed")
})
