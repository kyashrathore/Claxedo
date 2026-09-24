import type { SessionId, SessionRef, SessionRow } from "@/server"
import {
  WINDOW_ALL,
  compareOrder,
  insideWindow,
  newerRow,
  orderKey,
  type FetchedWindow,
  type ListData,
  type ListEntry,
  type OrderKey,
  type PendingSend,
  type StatusEntry,
} from "./model"

function withEntries<S extends ListData>(data: S, entries: ReadonlyMap<SessionId, ListEntry>): S {
  return { ...data, entries }
}

function setEntry<S extends ListData>(data: S, id: SessionId, entry: ListEntry): S {
  const entries = new Map(data.entries)
  entries.set(id, entry)
  return withEntries(data, entries)
}

function keptSend(send: PendingSend | undefined, row: SessionRow): PendingSend | undefined {
  if (!send || row.lastHumanTurnAt === undefined) return send
  const confirmed = send.humanTurnBefore === undefined || row.lastHumanTurnAt > send.humanTurnBefore
  return confirmed ? undefined : send
}

export function mergeRow<S extends ListData>(data: S, row: SessionRow): S {
  const id = row.ref.sessionId
  const current = data.entries.get(id)
  if (current?.kind === "tombstone") return data
  if (current?.kind !== "confirmed") return setEntry(data, id, { kind: "confirmed", row })
  const next = newerRow(current.row, row)
  if (!next) return data
  return setEntry(data, id, { kind: "confirmed", row: next, pendingSend: keptSend(current.pendingSend, next) })
}

export function upsertRow<S extends ListData>(data: S, row: SessionRow): S {
  const id = row.ref.sessionId
  const outsideWindow = !insideWindow(orderKey(row), data.windowTail)
  if (!data.entries.has(id) && !data.open.has(id) && outsideWindow) return data
  return mergeRow(data, row)
}

export function tombstoneRow<S extends ListData>(data: S, ref: SessionRef, at: number): S {
  const entries = new Map(data.entries)
  entries.set(ref.sessionId, { kind: "tombstone", ref, at })
  const statuses = new Map(data.statuses)
  statuses.delete(ref.sessionId)
  return { ...data, entries, statuses }
}

function pruneTombstones<S extends ListData>(data: S, before: number): S {
  let entries: Map<SessionId, ListEntry> | undefined
  for (const [id, entry] of data.entries) {
    if (entry.kind !== "tombstone" || entry.at >= before) continue
    entries ??= new Map(data.entries)
    entries.delete(id)
  }
  return entries ? withEntries(data, entries) : data
}

const laterKey = (a: OrderKey, b: OrderKey): OrderKey => (compareOrder(a, b) >= 0 ? a : b)

function windowTailOf(window: FetchedWindow, fallback: OrderKey): OrderKey {
  if (window.nextCursor === undefined) return WINDOW_ALL
  let tail: OrderKey | undefined
  for (const row of window.rows) tail = tail ? laterKey(tail, orderKey(row)) : orderKey(row)
  return tail ?? fallback
}

export function extendWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const windowTail = laterKey(data.windowTail, windowTailOf(window, data.windowTail))
  let next: S = { ...data, windowTail, nextCursor: window.nextCursor }
  for (const row of window.rows) next = mergeRow(next, row)
  return pruneTombstones(next, window.sentAt)
}

export function refreshWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const tail = windowTailOf(window, data.windowTail)
  const keepsWindow = compareOrder(data.windowTail, tail) >= 0
  let next: S = keepsWindow ? data : { ...data, windowTail: tail, nextCursor: window.nextCursor }
  for (const row of window.rows) next = mergeRow(next, row)
  return pruneTombstones(next, window.sentAt)
}

function dropMissingFromWindow<S extends ListData>(data: S, fetched: ReadonlySet<SessionId>): S {
  const entries = new Map(data.entries)
  const statuses = new Map<SessionId, StatusEntry>(data.statuses)
  for (const [id, entry] of data.entries) {
    if (entry.kind !== "confirmed" || fetched.has(id) || data.open.has(id)) continue
    if (!insideWindow(orderKey(entry.row), data.windowTail)) continue
    entries.delete(id)
    statuses.delete(id)
  }
  return { ...data, entries, statuses }
}

export function replaceWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const fetched = new Set(window.rows.map((row) => row.ref.sessionId))
  const dropped = dropMissingFromWindow(data, fetched)
  let next: S = { ...dropped, windowTail: windowTailOf(window, WINDOW_ALL), nextCursor: window.nextCursor }
  for (const row of window.rows) next = mergeRow(next, row)
  return pruneTombstones(next, window.sentAt)
}

function pendingEntryId(data: ListData, clientRequestId: string): SessionId | undefined {
  for (const [id, entry] of data.entries) if (entry.kind === "pending" && entry.clientRequestId === clientRequestId) return id
  return undefined
}

export function startCreate<S extends ListData>(data: S, clientRequestId: string, row: SessionRow): S {
  return setEntry(data, row.ref.sessionId, { kind: "pending", clientRequestId, row })
}

export function failCreate<S extends ListData>(data: S, clientRequestId: string): S {
  const id = pendingEntryId(data, clientRequestId)
  if (id === undefined) return data
  const entries = new Map(data.entries)
  entries.delete(id)
  return withEntries(data, entries)
}

export function confirmCreate<S extends ListData>(data: S, clientRequestId: string, row: SessionRow): S {
  return mergeRow(failCreate(data, clientRequestId), row)
}

export function startSend<S extends ListData>(data: S, sessionId: SessionId, clientRequestId: string, at: number): S {
  const entry = data.entries.get(sessionId)
  if (entry?.kind !== "confirmed") return data
  return setEntry(data, sessionId, { ...entry, pendingSend: { clientRequestId, at, humanTurnBefore: entry.row.lastHumanTurnAt } })
}

export function failSend<S extends ListData>(data: S, sessionId: SessionId, clientRequestId: string): S {
  const entry = data.entries.get(sessionId)
  if (entry?.kind !== "confirmed" || entry.pendingSend?.clientRequestId !== clientRequestId) return data
  return setEntry(data, sessionId, { kind: "confirmed", row: entry.row })
}

export function openSession<S extends ListData>(data: S, sessionId: SessionId): S {
  if (data.open.has(sessionId)) return data
  const open = new Set(data.open)
  open.add(sessionId)
  return { ...data, open }
}

export function closeSession<S extends ListData>(data: S, sessionId: SessionId): S {
  if (!data.open.has(sessionId)) return data
  const open = new Set(data.open)
  open.delete(sessionId)
  const entry = data.entries.get(sessionId)
  const keep = entry?.kind !== "confirmed" || insideWindow(orderKey(entry.row), data.windowTail)
  if (keep) return { ...data, open }
  const entries = new Map(data.entries)
  entries.delete(sessionId)
  const statuses = new Map(data.statuses)
  statuses.delete(sessionId)
  return { ...data, open, entries, statuses }
}
