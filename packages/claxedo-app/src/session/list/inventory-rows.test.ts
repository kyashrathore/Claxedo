/// <reference types="bun" />
import { expect, test } from "bun:test"
import { inventoryRows } from "./inventory-rows"
import { inventoryRow, inventoryTestState } from "./inventory.test-support"

function loaded(rows: ReturnType<typeof inventoryRow>[]) {
  const state = inventoryTestState()
  state.list.send({ type: "inventoryRead", rows, statuses: new Map(), sentAt: 1, ids: new Set(rows.map((row) => row.ref.sessionId)) })
  state.windows.active.send({ type: "received", revision: 0, more: false, page: { refs: rows.map((row) => row.ref), count: rows.length, degraded: false } })
  return { ...state, rows: () => inventoryRows(state.list.state().entries, state.windows.active.state()) }
}

test("work, input and Seen change row facts without moving or removing cards", () => {
  const older = { ...inventoryRow("older"), lastHumanTurnAt: 10 }
  const newest = { ...inventoryRow("newest"), lastHumanTurnAt: 20 }
  const state = loaded([older, newest])
  const attention = { ...older.attention!, sequence: 2, activitySequence: 2, working: true }
  state.list.send({ type: "attentionChanged", ref: older.ref, attention, delivery: "live" })
  expect(state.rows()).toEqual([newest.ref, older.ref])
  state.list.send({ type: "attentionChanged", ref: older.ref, attention: { ...attention, sequence: 3, awaitingInput: true }, delivery: "live" })
  expect(state.rows()).toEqual([newest.ref, older.ref])
  state.list.send({ type: "readerChanged", ref: newest.ref, reader: { generation: 1, revision: 1, seenThrough: 1, seenAt: 40 } })
  expect(state.rows()).toEqual([newest.ref, older.ref])
  state.list.send({ type: "sessionUpserted", row: { ...older, updatedAt: 50, lastHumanTurnAt: 50 } })
  expect(state.rows()).toEqual([older.ref, newest.ref])
})

test("settlement immediately excludes a card and stale pages cannot restore it", () => {
  const row = inventoryRow("settled")
  const state = loaded([row])
  const reader = { generation: 1, revision: 2, seenThrough: 0, settledThrough: 1, settledAt: 4 }
  state.list.send({ type: "readerChanged", ref: row.ref, reader })
  expect(state.rows()).toEqual([])
  state.list.send({ type: "inventoryRead", rows: [row], statuses: new Map(), sentAt: 2, ids: new Set([row.ref.sessionId]) })
  expect(state.rows()).toEqual([])
  expect(state.list.state().entries.get(row.ref.sessionId)).toMatchObject({ row: { reader } })
})

test("activity excludes archived, deleted and child rows and uses canonical human-turn ordering", () => {
  const older = inventoryRow("older", 10)
  const recent = { ...inventoryRow("recent", 1), lastHumanTurnAt: 20 }
  const archived = { ...inventoryRow("archived"), archivedAt: 1 }
  const child = { ...inventoryRow("child"), parentSessionId: older.ref.sessionId }
  const removed = inventoryRow("removed")
  const state = loaded([older, recent, archived, child, removed])
  state.list.send({ type: "sessionRemoved", ref: removed.ref, at: 2 })
  expect(state.rows()).toEqual([recent.ref, older.ref])
})

test("runtime disconnection preserves the same durable active row", () => {
  const row = { ...inventoryRow("offline"), executionAvailability: { status: "offline" as const, message: "Machine offline" }, attention: { ...inventoryRow("offline").attention!, working: true } }
  const state = loaded([row])
  expect(state.rows()).toEqual([row.ref])
  state.list.send({ type: "inventoryRead", rows: [{ ...row, executionAvailability: { status: "available" } }], statuses: new Map(), sentAt: 2, ids: new Set([row.ref.sessionId]) })
  expect(state.rows()).toEqual([row.ref])
})
