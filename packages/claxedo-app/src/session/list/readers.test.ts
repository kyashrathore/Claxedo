/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type SessionReader, type SessionRow } from "@/server"
import { initialListState, type FetchedWindow, type ListState } from "./model"
import { listTransition } from "./transition"
import { createRowViewCache, rowViews, visibleOrder } from "./visible-rows"

const ALPHA = projectId("prj_alpha")

function row(id: string, createdAt: number, lastHumanTurnAt?: number): SessionRow {
  return {
    ref: { projectId: ALPHA, placementId: placementId("prj_alpha_folder"), sessionId: sessionId(id) },
    title: id,
    createdAt,
    updatedAt: createdAt,
    ...(lastHumanTurnAt === undefined ? {} : { lastHumanTurnAt }),
  }
}

function window(rows: SessionRow[], readers: Array<[string, SessionReader]> = [], sentAt = 1_000): FetchedWindow {
  const page = { projectId: ALPHA, rows, nextAfter: undefined, degraded: false, statuses: new Map(), readers: new Map(readers.map(([id, reader]) => [sessionId(id), reader])) }
  return { pages: [page], failures: [], sentAt }
}

function run(state: ListState, ...events: Parameters<typeof listTransition>[1][]): ListState {
  return events.reduce(listTransition, state)
}

const shown = (state: ListState, showSettled = false) => visibleOrder(state, showSettled).map((ref) => ref.sessionId as string)

const rowView = (state: ListState, id: string) =>
  rowViews({ order: visibleOrder(state, true), data: state, openRequests: new Map(), cache: createRowViewCache() }).get(sessionId(id))

test("a listed row carries the reader's marks; a page sent before a notice loses to it, and a seen mark never falls", () => {
  const a1 = { ...row("a1", 50), lastTurn: { status: "completed" as const, completedAt: 70 } }
  const listed = (reader: SessionReader, sentAt: number) => window([a1], [["a1", reader]], sentAt)
  const marks = (state: ListState) => {
    const view = rowView(state, "a1")
    return { seenAt: view?.seenAt, settledAt: view?.settledAt }
  }
  const unseen = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: listed({}, 1_000) })
  expect(marks(unseen)).toEqual({ seenAt: undefined, settledAt: undefined })

  const noticed = run(unseen, { type: "readerChanged", ref: a1.ref, reader: { seenAt: 70, settledAt: 70 }, at: 1_100 })
  expect(marks(noticed)).toEqual({ seenAt: 70, settledAt: 70 })
  const stale = run(noticed, { type: "rereadStarted" }, { type: "rereadFetched", mode: "refresh", window: listed({}, 1_050) })
  expect(marks(stale)).toEqual({ seenAt: 70, settledAt: 70 })
  const fresh = run(stale, { type: "rereadStarted" }, { type: "rereadFetched", mode: "refresh", window: listed({ seenAt: 60 }, 1_200) })
  expect(marks(fresh)).toEqual({ seenAt: 70, settledAt: undefined })
})

test("a reader write shows at once as a pending entry, the server's answer confirms it, and a refused write rolls it back", () => {
  const a1 = { ...row("a1", 50), lastTurn: { status: "failed" as const, completedAt: 70 } }
  const live = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([a1]) })
  const started = run(live, { type: "readerWriteStarted", sessionId: a1.ref.sessionId, writeId: "w1", reader: { seenAt: 70 } })
  expect(rowView(started, "a1")?.seenAt).toBe(70)
  expect(run(started, { type: "readerWritten", sessionId: a1.ref.sessionId, writeId: "w1", reader: { seenAt: 70 }, at: 1_100 }).readers.get(a1.ref.sessionId))
    .toEqual({ reader: { seenAt: 70 }, at: 1_100, source: "event" })
  const refused = run(started, { type: "readerWriteFailed", sessionId: a1.ref.sessionId, writeId: "w1" })
  expect(rowView(refused, "a1")?.seenAt).toBeUndefined()
})

test("a settled row leaves the rail unless Show settled is on, and a later send or turn result returns it with no write", () => {
  const a1 = { ...row("a1", 50, 60), lastTurn: { status: "completed" as const, completedAt: 70 } }
  const a2 = row("a2", 40)
  const live = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([a1, a2], [["a1", { settledAt: 70 }]]) })
  expect(shown(live)).toEqual(["a2"])
  expect(shown(live, true)).toEqual(["a1", "a2"])

  const answered = run(live, { type: "statusChanged", ref: a1.ref, status: { kind: "idle" }, lastTurn: { status: "failed", completedAt: 80 }, at: 1_100 })
  expect(shown(answered)).toEqual(["a1", "a2"])
  const sending = run(live, { type: "sendStarted", sessionId: a1.ref.sessionId, clientRequestId: "c1", at: 1_200 })
  expect(shown(sending)).toEqual(["a1", "a2"])

  const returned = run(live, { type: "readerWriteStarted", sessionId: a1.ref.sessionId, writeId: "w2", reader: {} })
  expect(shown(returned)).toEqual(["a1", "a2"])
})

test("a page that carries no marks for a row leaves the marks the store holds", () => {
  const a1 = { ...row("a1", 50), lastTurn: { status: "completed" as const, completedAt: 70 } }
  const held = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([a1], [["a1", { seenAt: 70, settledAt: 70 }]], 1_000) })
  const partial = run(held, { type: "rereadStarted" }, { type: "rereadFetched", mode: "refresh", window: window([a1], [], 1_200) })
  expect(rowView(partial, "a1")?.seenAt).toBe(70)
  expect(shown(partial, true)).toEqual(["a1"])
  expect(shown(partial)).toEqual([])
})
