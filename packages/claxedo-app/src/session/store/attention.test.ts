/// <reference types="bun" />
import { expect, test } from "bun:test"
import { NO_BACKGROUND_WORK, placementId, projectId, sessionId, type BackgroundWork, type ServerEvent, type SessionRow } from "@/server"
import type { SessionRowView } from "@/session"
import { attentionRaised } from "./attention"

const ref = { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") }

function held(input: { completedAt?: number; waiting?: boolean; work?: BackgroundWork } = {}) {
  const row: SessionRow = {
    ref,
    title: "One",
    createdAt: 1,
    updatedAt: 1,
    ...(input.completedAt !== undefined ? { lastTurn: { status: "completed", completedAt: input.completedAt } } : {}),
  }
  const view: SessionRowView = { ...row, status: { kind: "idle" }, waitingOnUser: input.waiting ?? false, pending: false }
  return { rowOf: () => row, view: () => view, backgroundWorkOf: () => input.work ?? NO_BACKGROUND_WORK }
}

const ended = (status: "completed" | "failed" | "cancelled", completedAt: number, fields: Partial<Extract<ServerEvent, { type: "statusChanged" }>> = {}): ServerEvent =>
  ({ type: "statusChanged", ref, status: { kind: "idle" }, lastTurn: { status, completedAt }, ...fields })

test("attention: a last turn that ends after the one the row holds finishes or fails the session, open or not", () => {
  expect(attentionRaised(ended("completed", 20), held({ completedAt: 10 }))).toEqual({ kind: "finished", ref })
  expect(attentionRaised(ended("failed", 20), held({ completedAt: 10 }))).toEqual({ kind: "failed", ref })
  expect(attentionRaised(ended("completed", 20), held())).toEqual({ kind: "finished", ref })
  expect(attentionRaised(ended("cancelled", 20), held({ completedAt: 10 }))).toBeUndefined()
})

test("attention: the turn the row already holds, re-read or replayed, raises nothing", () => {
  expect(attentionRaised(ended("completed", 10), held({ completedAt: 10 }))).toBeUndefined()
  expect(attentionRaised(ended("completed", 5), held({ completedAt: 10 }))).toBeUndefined()
  expect(attentionRaised(ended("completed", 20, { replayed: true }), held({ completedAt: 10 }))).toBeUndefined()
  expect(attentionRaised({ type: "statusChanged", ref, status: { kind: "working" } }, held({ completedAt: 10 }))).toBeUndefined()
})

test("attention: a turn that ends while background work runs finishes nothing yet, and a failure still alerts", () => {
  const running = { agents: 1, shells: 0, other: 0 }
  expect(attentionRaised(ended("completed", 20), held({ completedAt: 10, work: running }))).toBeUndefined()
  expect(attentionRaised(ended("completed", 20, { backgroundWork: running }), held({ completedAt: 10 }))).toBeUndefined()
  expect(attentionRaised(ended("completed", 20, { backgroundWork: NO_BACKGROUND_WORK }), held({ completedAt: 10, work: running }))).toEqual({ kind: "finished", ref })
  expect(attentionRaised(ended("failed", 20), held({ completedAt: 10, work: running }))).toEqual({ kind: "failed", ref })
})

test("attention: a wait on the reader that rises asks for them once; a permission request always does", () => {
  const waiting: ServerEvent = { type: "statusChanged", ref, status: { kind: "working" }, waitingOnUser: true }
  expect(attentionRaised(waiting, held())).toEqual({ kind: "waiting", ref })
  expect(attentionRaised(waiting, held({ waiting: true }))).toBeUndefined()
  expect(attentionRaised({ ...waiting, replayed: true }, held())).toBeUndefined()
  const permission = { kind: "permission" } as Extract<ServerEvent, { type: "requestOpened" }>["request"]
  expect(attentionRaised({ type: "requestOpened", ref, request: permission }, held({ waiting: true }))).toEqual({ kind: "waiting", ref })
})
