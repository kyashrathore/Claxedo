import type { ProjectId, SessionId, SessionRef, SessionRow } from "@/server"
import {
  WINDOW_ALL,
  compareOrder,
  insideProjectWindow,
  newerRow,
  windowTail,
  orderKey,
  type FetchedPage,
  type FetchedWindow,
  type ListData,
  type ListEntry,
  type OrderKey,
  type PendingSend,
  type ProjectWindow,
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
  return send && row.updatedAt <= send.updatedBefore ? send : undefined
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
  const outsideWindow = !insideProjectWindow(data, row)
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

function pageTail(page: FetchedPage, fallback: OrderKey): OrderKey {
  if (page.nextAfter === undefined) return WINDOW_ALL
  let tail: OrderKey | undefined
  for (const row of page.rows) tail = tail ? laterKey(tail, orderKey(row)) : orderKey(row)
  return tail ?? fallback
}

function withWindows<S extends ListData>(data: S, window: FetchedWindow, change: (windows: Map<ProjectId, ProjectWindow>) => void): S {
  const windows = new Map(data.windows)
  change(windows)
  const failures = new Map(data.failures)
  const degraded = new Set(data.degraded)
  for (const page of window.pages) {
    failures.delete(page.projectId)
    if (page.degraded) degraded.add(page.projectId)
    else degraded.delete(page.projectId)
  }
  for (const failed of window.failures) {
    failures.set(failed.projectId, failed.error)
    degraded.delete(failed.projectId)
  }
  return { ...data, windows, failures, degraded }
}

function mergePages<S extends ListData>(data: S, window: FetchedWindow): S {
  let next = data
  for (const page of window.pages) for (const row of page.rows) next = mergeRow(next, row)
  return pruneTombstones(next, window.sentAt)
}

export function extendWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const next = withWindows(data, window, (windows) => {
    for (const page of window.pages) {
      const current = windowTail(data, page.projectId)
      windows.set(page.projectId, { tail: laterKey(current, pageTail(page, current)), nextAfter: page.nextAfter })
    }
  })
  return mergePages(next, window)
}

export function refreshWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const next = withWindows(data, window, (windows) => {
    for (const page of window.pages) {
      const current = windowTail(data, page.projectId)
      const tail = pageTail(page, current)
      if (data.windows.has(page.projectId) && compareOrder(current, tail) >= 0) continue
      windows.set(page.projectId, { tail, nextAfter: page.nextAfter })
    }
  })
  return mergePages(next, window)
}

function dropMissingFromPages<S extends ListData>(data: S, window: FetchedWindow): S {
  const fetched = new Set(window.pages.flatMap((page) => page.rows.map((row) => row.ref.sessionId)))
  const read = new Set(window.pages.map((page) => page.projectId))
  const entries = new Map(data.entries)
  const statuses = new Map<SessionId, StatusEntry>(data.statuses)
  for (const [id, entry] of data.entries) {
    if (entry.kind !== "confirmed" || fetched.has(id) || data.open.has(id)) continue
    if (!read.has(entry.row.ref.projectId) || !insideProjectWindow(data, entry.row)) continue
    entries.delete(id)
    statuses.delete(id)
  }
  return { ...data, entries, statuses }
}

export function replaceWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const next = withWindows(dropMissingFromPages(data, window), window, (windows) => {
    for (const page of window.pages) windows.set(page.projectId, { tail: pageTail(page, WINDOW_ALL), nextAfter: page.nextAfter })
  })
  return mergePages(next, window)
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
  return setEntry(data, sessionId, { ...entry, pendingSend: { clientRequestId, at, updatedBefore: entry.row.updatedAt } })
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
  const keep = entry?.kind !== "confirmed" || insideProjectWindow(data, entry.row)
  if (keep) return { ...data, open }
  const entries = new Map(data.entries)
  entries.delete(sessionId)
  const statuses = new Map(data.statuses)
  statuses.delete(sessionId)
  return { ...data, open, entries, statuses }
}
