/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type SessionRow } from "@/server"
import { initialListState, type FetchedWindow, type ListEvent, type ListState } from "./model"
import { listTransition } from "./transition"
import { visibleOrder } from "./visible-rows"

const project = projectId("p")
const row: SessionRow = { ref: { projectId: project, placementId: placementId("w"), sessionId: sessionId("s") }, title: "Result", createdAt: 1, updatedAt: 20 }
const window = (rows: SessionRow[]): FetchedWindow => ({ pages: [{ projectId: project, rows, statuses: new Map(), nextAfter: undefined, degraded: false }], failures: [], sentAt: 100 })
const run = (state: ListState, ...events: ListEvent[]) => events.reduce(listTransition, state)
const inventory = (rows: SessionRow[]): ListEvent => ({ type: "inventoryRead", rows, ids: new Set(rows.map((row) => row.ref.sessionId)), statuses: new Map(), sentAt: 100 })

test("gap recovery removes a missing row regardless of project/inventory response order", () => {
  const loaded = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([row]) }, inventory([row]))
  const replace: ListEvent[] = [{ type: "rereadStarted" }, { type: "rereadFetched", mode: "replace", window: window([]) }]
  for (const events of [[...replace, inventory([])], [inventory([]), ...replace]]) {
    const next = run(loaded, ...events)
    expect(visibleOrder(next)).toEqual([])
    expect(next.entries.has(row.ref.sessionId)).toBe(false)
  }
})

test("an open transcript and inventory keep one row while the replaced project window excludes it", () => {
  const loaded = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([row]) }, inventory([row]), { type: "sessionOpened", sessionId: row.ref.sessionId })
  const next = run(loaded, { type: "rereadStarted" }, { type: "rereadFetched", mode: "replace", window: window([]) }, inventory([]))
  expect(visibleOrder(next)).toEqual([])
  expect(next.entries.get(row.ref.sessionId)?.kind).toBe("confirmed")
  const closed = run(next, { type: "sessionClosed", sessionId: row.ref.sessionId })
  expect(closed.entries.has(row.ref.sessionId)).toBe(false)
})

test("a successful project refresh can readmit a previously excluded session", () => {
  const loaded = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: window([row]) }, inventory([row]))
  const omitted = run(loaded, { type: "rereadStarted" }, { type: "rereadFetched", mode: "replace", window: window([]) })
  expect(visibleOrder(omitted)).toEqual([])
  const refreshed = run(omitted, { type: "rereadStarted" }, { type: "rereadFetched", mode: "refresh", window: window([row]) })
  expect(visibleOrder(refreshed)).toEqual([row.ref])
})

test("evicting a transcript retains its inventory row beyond the project page until inventory releases it", () => {
  const newer: SessionRow = { ...row, ref: { ...row.ref, sessionId: sessionId("newer") }, createdAt: 2 }
  const firstPage = window([newer])
  const paged = { ...firstPage, pages: firstPage.pages.map((page) => ({ ...page, nextAfter: "older" })) }
  const loaded = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: paged }, inventory([row]), { type: "sessionOpened", sessionId: row.ref.sessionId })
  const entry = loaded.entries.get(row.ref.sessionId)
  expect(visibleOrder(loaded)).toEqual([newer.ref])

  const evicted = run(loaded, { type: "sessionClosed", sessionId: row.ref.sessionId })
  expect(evicted.open.has(row.ref.sessionId)).toBe(false)
  expect(evicted.inventoryIds.has(row.ref.sessionId)).toBe(true)
  expect(evicted.entries.get(row.ref.sessionId)).toBe(entry)
  expect(visibleOrder(evicted)).toEqual([newer.ref])

  const released = run(evicted, inventory([]))
  expect(released.entries.has(row.ref.sessionId)).toBe(false)
  expect(visibleOrder(released)).toEqual([newer.ref])
})

test("an older project read cannot replace newer inventory availability, even when metadata timestamps are equal", () => {
  const available: SessionRow = { ...row, executionAvailability: { status: "available" } }
  const offline: SessionRow = { ...row, executionAvailability: { status: "offline", message: "Machine offline" } }
  const loaded = run(initialListState, { type: "fetchStarted" }, { type: "fetched", window: { ...window([available]), sentAt: 10 } })
  const current = run(loaded, { ...inventory([offline]), sentAt: 30 } as ListEvent, { type: "rereadStarted" }, { type: "rereadFetched", mode: "refresh", window: { ...window([available]), sentAt: 20 } })
  expect(current.entries.get(row.ref.sessionId)).toMatchObject({ row: { executionAvailability: offline.executionAvailability } })
  const latest = run(current, { type: "rereadStarted" }, { type: "rereadFetched", mode: "refresh", window: { ...window([{ ...available, updatedAt: 19 }]), sentAt: 40 } })
  expect(latest.entries.get(row.ref.sessionId)).toMatchObject({ row: { updatedAt: 20, executionAvailability: available.executionAvailability } })
})
