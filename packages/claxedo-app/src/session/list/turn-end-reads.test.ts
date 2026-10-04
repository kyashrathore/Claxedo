/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machine } from "@/lib/machine"
import { placementId, projectId, sessionId, type Server, type SessionListInput, type SessionRow } from "@/server"
import { ACTIVITY_WINDOW, initialListState, type FetchedWindow, type ListState } from "./model"
import { createListReads } from "./reads"
import { listTransition } from "./transition"
import { createTurnEndReads } from "./turn-end-reads"
import { visibleOrder } from "./visible-rows"

const ALPHA = projectId("prj_alpha")
const ref = (id: string) => ({ projectId: ALPHA, placementId: placementId("plc_alpha"), sessionId: sessionId(id) })
const row = (id: string, lastHumanTurnAt: number, extra: Partial<SessionRow> = {}): SessionRow => ({ ref: ref(id), title: id, createdAt: 1, updatedAt: 1, lastHumanTurnAt, ...extra })
const window = (rows: SessionRow[], sentAt = 1_000, nextAfter?: string): FetchedWindow => ({
  pages: [{ windowKey: ALPHA, rows, nextAfter, degraded: false, statuses: new Map(rows.map((listed) => [listed.ref.sessionId, { status: { kind: "idle" as const }, waitingOnUser: false, backgroundWork: { agents: 0, shells: 0, other: 0 } }])), readers: new Map(rows.map((listed) => [listed.ref.sessionId, { seenAt: 5 }])) }],
  failures: [],
  sentAt,
})
const live = listTransition(listTransition(initialListState, { type: "fetchStarted" }), { type: "fetched", window: window([row("loaded", 90), row("tail", 50)], 1_000, "more") })
const ended = { status: "completed" as const, completedAt: 200 }

function reader(state: ListState, showSettled = false) {
  const asked: string[] = []
  const notice = createTurnEndReads({ state: () => state, showSettled: () => showSettled, read: (target, lastTurn) => asked.push(`${target.sessionId}@${lastTurn.completedAt}`) })
  return { asked, notice }
}

test("a turn end reads an unloaded session's row once per turn, and never for a replay, a loaded row, a status with no turn, or under Show settled", () => {
  const { asked, notice } = reader(live)
  notice({ ref: ref("settled"), lastTurn: ended, replayed: true })
  notice({ ref: ref("settled") })
  notice({ ref: ref("loaded"), lastTurn: ended })
  notice({ ref: ref("settled"), lastTurn: ended })
  notice({ ref: ref("settled"), lastTurn: ended })
  notice({ ref: ref("settled"), lastTurn: { status: "completed", completedAt: 150 } })
  notice({ ref: ref("settled"), lastTurn: { status: "failed", completedAt: 300 } })
  expect(asked).toEqual(["settled@200", "settled@300"])

  const shown = reader(live, true)
  shown.notice({ ref: ref("settled"), lastTurn: ended })
  expect(shown.asked).toEqual([])
  const empty = reader(initialListState)
  empty.notice({ ref: ref("settled"), lastTurn: ended })
  expect(empty.asked).toEqual([])
})

test("a turn end's row outside every window, or a child, writes no status or marks", () => {
  for (const refused of [row("old", 10), row("child", 95, { parentSessionId: sessionId("loaded") })]) {
    const next = listTransition(live, { type: "turnEndRowRead", window: window([refused], 2_000), ref: refused.ref, lastTurn: ended })
    expect(visibleOrder(next, false, "projects").map((shown) => shown.sessionId as string)).toEqual(["loaded", "tail"])
    expect(next.statuses.has(refused.ref.sessionId)).toBe(false)
    expect(next.readers.has(refused.ref.sessionId)).toBe(false)
  }
})

test("a turn end's row read while the list re-reads waits for the re-read, so a replace cannot drop it", () => {
  const rereading = listTransition(live, { type: "rereadStarted" })
  const held = listTransition(rereading, { type: "turnEndRowRead", window: window([row("settled", 70)], 1_500), ref: ref("settled"), lastTurn: ended })
  expect(held.entries.has(sessionId("settled"))).toBe(false)
  const replaced = listTransition(held, { type: "rereadFetched", mode: "replace", window: window([row("loaded", 90), row("tail", 50)], 1_200, "more") })
  expect(visibleOrder(replaced, false, "projects").map((shown) => shown.sessionId as string)).toEqual(["loaded", "settled", "tail"])
  const entry = replaced.entries.get(sessionId("settled"))
  expect(entry?.kind === "confirmed" ? entry.row.lastTurn : undefined).toEqual(ended)
})

test("showing Activity again reads no further page once its window is open", async () => {
  const reads: SessionListInput[] = []
  const server = {
    placements: { load: async () => [{ projectId: ALPHA }] },
    sessions: { list: async (input: SessionListInput) => (reads.push(input), { rows: [], statuses: new Map(), readers: new Map(), nextAfter: "more" }) },
  } as unknown as Server
  const list = machine<ListState, Parameters<typeof listTransition>[1]>(initialListState, listTransition)
  const listReads = createListReads(server, list, { settled: () => "active", activityShown: () => true })
  await listReads.fetchFirst()
  expect(list.state().windows.has(ACTIVITY_WINDOW)).toBe(true)
  await listReads.openActivity()
  expect(reads.filter((input) => "every" in input)).toHaveLength(1)
})
