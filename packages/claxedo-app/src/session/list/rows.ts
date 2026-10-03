import { sameHarnessSelection } from "@/lib/harness-selection"
import { sameModelKey, type ProjectId, type SessionId, type SessionLocation, type SessionRow, type SessionSelections } from "@/server"
import {
  WINDOW_ALL,
  compareOrder,
  insideProjectWindow,
  windowTail,
  orderKey,
  type FetchedPage,
  type FetchedWindow,
  type ListData,
  type ListEntry,
  type OrderKey,
  type PendingSend,
  type ProjectWindow,
} from "./model"
import { newerRow } from "./row-version"
import { withoutSessionFacts } from "./statuses"

function withEntries<S extends ListData>(data: S, entries: ReadonlyMap<SessionId, ListEntry>): S {
  return { ...data, entries }
}

function setEntry<S extends ListData>(data: S, id: SessionId, entry: ListEntry): S {
  const entries = new Map(data.entries)
  entries.set(id, entry)
  return withEntries(data, entries)
}

type SelectionKey = keyof SessionSelections

const sameSelection: { readonly [K in SelectionKey]: (a: SessionSelections[K], b: SessionSelections[K]) => boolean } = {
  harness: sameHarnessSelection,
  model: sameModelKey,
  permissionMode: (a, b) => a === b,
  permissionModeLabel: (a, b) => a === b,
}

const sameSelectionField = <K extends SelectionKey>(key: K, a: SessionSelections, b: SessionSelections) => sameSelection[key](a[key], b[key])

function sameSelections(a: SessionSelections, b: SessionSelections): boolean {
  return (Object.keys(sameSelection) as SelectionKey[]).every((key) => sameSelectionField(key, a, b))
}

const sameTurn = (a: SessionRow["lastTurn"], b: SessionRow["lastTurn"]) => a?.status === b?.status && a?.completedAt === b?.completedAt

function onlySelectionsMoved(held: SessionRow, row: SessionRow): boolean {
  return row.lastHumanTurnAt === held.lastHumanTurnAt && sameTurn(row.lastTurn, held.lastTurn) && !sameSelections(held, row)
}

function keptSend(send: PendingSend | undefined, held: SessionRow, row: SessionRow): PendingSend | undefined {
  if (!send || row.updatedAt <= send.updatedBefore) return send
  return onlySelectionsMoved(held, row) ? send : undefined
}

export function mergeRow<S extends ListData>(data: S, row: SessionRow, availabilityReadAt?: number): S {
  const id = row.ref.sessionId
  const current = data.entries.get(id)
  if (current?.kind === "tombstone") return data
  if (current?.kind !== "confirmed") return setEntry(data, id, { kind: "confirmed", row, availabilityReadAt })
  const incoming = { ...row, executionAvailability: current.row.executionAvailability }
  const versioned = newerRow(current.row, incoming)
  const freshAvailability = availabilityReadAt !== undefined && availabilityReadAt >= (current.availabilityReadAt ?? 0)
  if (!versioned && !freshAvailability) return data
  const next = freshAvailability ? { ...(versioned ?? current.row), executionAvailability: row.executionAvailability } : versioned!
  return setEntry(data, id, { kind: "confirmed", row: next, pendingSend: keptSend(current.pendingSend, current.row, next), availabilityReadAt: freshAvailability ? availabilityReadAt : current.availabilityReadAt })
}

export function upsertRow<S extends ListData>(data: S, row: SessionRow): S {
  const id = row.ref.sessionId
  const outsideWindow = !insideProjectWindow(data, row)
  if (!data.entries.has(id) && !data.open.has(id) && outsideWindow) return data
  return mergeRow(data, row)
}

export function tombstoneRow<S extends ListData>(data: S, ref: SessionLocation, at: number): S {
  const entries = new Map(data.entries)
  entries.set(ref.sessionId, { kind: "tombstone", ref, at })
  return { ...data, entries, ...withoutSessionFacts(data, [ref.sessionId]) }
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
  for (const page of window.pages) for (const row of page.rows) next = mergeRow(next, row, window.sentAt)
  return pruneTombstones(next, window.sentAt)
}

function exclusions(data: ListData, page: FetchedPage, replacing: boolean): ReadonlySet<SessionId> {
  const excluded = new Set(data.windows.get(page.projectId)?.excluded)
  const fetched = new Set(page.rows.map((row) => row.ref.sessionId))
  if (replacing) for (const [id, entry] of data.entries) {
    if (entry.kind === "confirmed" && entry.row.ref.projectId === page.projectId && !fetched.has(id) && insideProjectWindow(data, entry.row)) excluded.add(id)
  }
  for (const id of fetched) excluded.delete(id)
  return excluded
}

export function extendWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const next = withWindows(data, window, (windows) => {
    for (const page of window.pages) {
      const current = windowTail(data, page.projectId)
      windows.set(page.projectId, { tail: laterKey(current, pageTail(page, current)), nextAfter: page.nextAfter, excluded: exclusions(data, page, false) })
    }
  })
  return mergePages(next, window)
}

export function refreshWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const next = withWindows(data, window, (windows) => {
    for (const page of window.pages) {
      const current = windowTail(data, page.projectId)
      const tail = pageTail(page, current)
      const retained = data.windows.has(page.projectId) && compareOrder(current, tail) >= 0
      windows.set(page.projectId, { tail: retained ? current : tail, nextAfter: retained ? data.windows.get(page.projectId)?.nextAfter : page.nextAfter, excluded: exclusions(data, page, false) })
    }
  })
  return mergePages(next, window)
}

function dropMissingFromPages<S extends ListData>(data: S, window: FetchedWindow): S {
  const fetched = new Set(window.pages.flatMap((page) => page.rows.map((row) => row.ref.sessionId)))
  const read = new Set(window.pages.map((page) => page.projectId))
  const entries = new Map(data.entries)
  const dropped: SessionId[] = []
  for (const [id, entry] of data.entries) {
    if (entry.kind !== "confirmed" || fetched.has(id) || data.open.has(id) || data.inventoryIds.has(id)) continue
    if (!read.has(entry.row.ref.projectId) || !insideProjectWindow(data, entry.row)) continue
    entries.delete(id)
    dropped.push(id)
  }
  return { ...data, entries, ...withoutSessionFacts(data, dropped) }
}

export function replaceWindow<S extends ListData>(data: S, window: FetchedWindow): S {
  const next = withWindows(dropMissingFromPages(data, window), window, (windows) => {
    for (const page of window.pages) windows.set(page.projectId, { tail: pageTail(page, WINDOW_ALL), nextAfter: page.nextAfter, excluded: exclusions(data, page, true) })
  })
  return mergePages(next, window)
}

export function replaceInventoryMembership<S extends ListData>(data: S, inventoryIds: ReadonlySet<SessionId>): S {
  const entries = new Map(data.entries)
  const dropped: SessionId[] = []
  for (const id of data.inventoryIds) {
    const entry = entries.get(id)
    if (!inventoryIds.has(id) && !data.open.has(id) && entry?.kind === "confirmed" && !insideProjectWindow(data, entry.row)) {
      entries.delete(id)
      dropped.push(id)
    }
  }
  const windows = new Map([...data.windows].map(([id, window]) => [id, { ...window, excluded: new Set([...window.excluded].filter((id) => entries.has(id))) }]))
  return { ...data, entries, windows, inventoryIds, ...withoutSessionFacts(data, dropped) }
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
  return setEntry(data, sessionId, { kind: "confirmed", row: entry.row, availabilityReadAt: entry.availabilityReadAt })
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
  const keep = entry?.kind !== "confirmed" || data.inventoryIds.has(sessionId) || insideProjectWindow(data, entry.row)
  if (keep) return { ...data, open }
  const entries = new Map(data.entries)
  entries.delete(sessionId)
  return { ...data, open, entries, ...withoutSessionFacts(data, [sessionId]) }
}
