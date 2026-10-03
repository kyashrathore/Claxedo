/// <reference types="bun" />
import { expect, test } from "bun:test"
import { NO_BACKGROUND_WORK, placementId, projectId, ServerError, sessionId, type BackgroundWork, type ServerEvent, type SessionRow } from "@/server"
import type { SessionRowView, SessionStatusView } from "@/session"
import { attentionRaised } from "./attention"

const ref = { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") }

function held(input: { completedAt?: number; waiting?: boolean; work?: BackgroundWork; status?: SessionStatusView } = {}) {
  const row: SessionRow = {
    ref,
    title: "One",
    createdAt: 1,
    updatedAt: 1,
    ...(input.completedAt !== undefined ? { lastTurn: { status: "completed", completedAt: input.completedAt } } : {}),
  }
  const status = input.status ?? { kind: "idle" }
  const view: SessionRowView = { ...row, status, waitingOnUser: input.waiting ?? false, pending: false }
  return { rowOf: () => row, view: () => view, statusOf: () => status, backgroundWorkOf: () => input.work ?? NO_BACKGROUND_WORK }
}

const ended = (status: "completed" | "failed" | "cancelled", completedAt: number, fields: Partial<Extract<ServerEvent, { type: "statusChanged" }>> = {}): ServerEvent =>
  ({ type: "statusChanged", ref, status: { kind: "idle" }, lastTurn: { status, completedAt }, ...fields })

const kinds = (event: ServerEvent, rows: ReturnType<typeof held>) => attentionRaised(event, rows).map((attention) => attention.kind)

test("attention: a last turn that ends after the one the row holds finishes or fails the session, open or not", () => {
  expect(attentionRaised(ended("completed", 20), held({ completedAt: 10 }))).toEqual([{ kind: "finished", ref }])
  expect(kinds(ended("failed", 20), held({ completedAt: 10 }))).toEqual(["failed"])
  expect(kinds(ended("completed", 20), held())).toEqual(["finished"])
  expect(kinds(ended("cancelled", 20), held({ completedAt: 10 }))).toEqual([])
})

test("attention: the turn the row already holds, re-read or replayed, raises nothing", () => {
  expect(kinds(ended("completed", 10), held({ completedAt: 10 }))).toEqual([])
  expect(kinds(ended("completed", 5), held({ completedAt: 10 }))).toEqual([])
  expect(kinds(ended("completed", 20, { replayed: true }), held({ completedAt: 10 }))).toEqual([])
  expect(kinds({ type: "statusChanged", ref, status: { kind: "working" } }, held({ completedAt: 10 }))).toEqual([])
})

test("attention: a turn that ends while background work runs finishes nothing yet, and a failure still alerts", () => {
  const running = { agents: 1, shells: 0, other: 0 }
  expect(kinds(ended("completed", 20), held({ completedAt: 10, work: running }))).toEqual([])
  expect(kinds(ended("completed", 20, { backgroundWork: running }), held({ completedAt: 10 }))).toEqual([])
  expect(kinds(ended("completed", 20, { backgroundWork: NO_BACKGROUND_WORK }), held({ completedAt: 10, work: running }))).toEqual(["finished"])
  expect(kinds(ended("failed", 20), held({ completedAt: 10, work: running }))).toEqual(["failed"])
})

test("attention: a failure the runtime reports with no recorded turn fails the session once", () => {
  const failed = { kind: "failed", error: new ServerError({ class: "internal", message: "The harness refused the prompt" }) } as const
  const admissionFailure: ServerEvent = { type: "statusChanged", ref, status: failed }

  expect(kinds(admissionFailure, held({ completedAt: 10 }))).toEqual(["failed"])
  expect(kinds(admissionFailure, held({ completedAt: 10, status: failed })), "the row already shows the failure").toEqual([])
  expect(kinds(ended("failed", 20, { status: failed }), held({ completedAt: 10, status: failed })), "the turn's end reporting the failure the stream already did").toEqual([])
  expect(kinds(ended("failed", 20, { status: failed }), held({ completedAt: 10, status: { kind: "working" } })), "the next turn's failure").toEqual(["failed"])
})

test("attention: a wait on the reader that rises asks for them once, a permission or a question alike", () => {
  const waiting: ServerEvent = { type: "statusChanged", ref, status: { kind: "working" }, waitingOnUser: true }
  expect(kinds(waiting, held())).toEqual(["waiting"])
  expect(kinds(waiting, held({ waiting: true }))).toEqual([])
  expect(kinds({ ...waiting, replayed: true }, held())).toEqual([])
  for (const kind of ["permission", "question"] as const) {
    const request = { kind } as Extract<ServerEvent, { type: "requestOpened" }>["request"]
    expect(kinds({ type: "requestOpened", ref, request }, held())).toEqual(["waiting"])
    expect(kinds({ type: "requestOpened", ref, request }, held({ waiting: true }))).toEqual([])
  }
})

test("attention: a notice that ends a turn and starts a wait raises both", () => {
  expect(kinds(ended("completed", 20, { waitingOnUser: true }), held({ completedAt: 10 }))).toEqual(["waiting", "finished"])
})

test.each<[string, ServerEvent[]]>([
  ["a prompt the runtime refuses before any turn", [{ type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "refused" }) } }]],
  ["a stream that throws, then the turn's end", [
    { type: "statusChanged", ref, status: { kind: "working" } },
    { type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "stream" }) } },
    { type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "stream" }) }, lastTurn: { status: "failed", completedAt: 20 } },
  ]],
  ["a harness error chunk, then the turn's end", [
    { type: "statusChanged", ref, status: { kind: "working" } },
    { type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "harness" }) } },
    { type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "harness" }) }, lastTurn: { status: "failed", completedAt: 20 } },
  ]],
  ["the turn's end, then the route's own report of the same failure", [
    { type: "statusChanged", ref, status: { kind: "working" } },
    { type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "turn" }) }, lastTurn: { status: "failed", completedAt: 20 } },
    { type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "turn" }) } },
  ]],
])("attention: %s fails the session exactly once", (_name, events) => {
  let status: SessionStatusView = { kind: "idle" }
  let completedAt = 10
  const raised = events.flatMap((event) => {
    const attention = attentionRaised(event, held({ completedAt, status }))
    if (event.type === "statusChanged") {
      status = event.status
      completedAt = Math.max(completedAt, event.lastTurn?.completedAt ?? 0)
    }
    return attention.map((item) => item.kind)
  })
  expect(raised).toEqual(["failed"])
})
