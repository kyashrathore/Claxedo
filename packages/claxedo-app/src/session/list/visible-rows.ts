import { NO_BACKGROUND_WORK, sessionSettled, sessionStatusWithBackgroundWork, type AgentRequest, type SessionId, type SessionLocation, type SessionReader } from "@/server"
import type { SessionRowView, SessionStatusView } from "@/session"
import {
  ACTIVITY_WINDOW,
  compareOrder,
  entryActivityAt,
  insideListWindow,
  orderKey,
  type ConfirmedEntry,
  type ListData,
  type OrderKey,
  type PendingEntry,
} from "./model"
import { readerOf } from "./readers"

type Shown = { readonly entry: ConfirmedEntry | PendingEntry; readonly key: OrderKey }

type CachedView = {
  readonly entry: ConfirmedEntry | PendingEntry
  readonly reader: SessionReader
  readonly status: SessionStatusView
  readonly waitingOnUser: boolean
  readonly view: SessionRowView
}

export type RowViewCache = { current: ReadonlyMap<SessionId, CachedView> }

export const UNKNOWN_STATUS: SessionStatusView = { kind: "unknown" }

export const createRowViewCache = (): RowViewCache => ({ current: new Map() })

type OrderData = Pick<ListData, "entries" | "windows" | "readers">

function entrySettled(entry: ConfirmedEntry | PendingEntry, reader: SessionReader): boolean {
  return entry.kind === "confirmed" && !entry.pendingSend && sessionSettled(entry.row, reader)
}

export type ListView = "projects" | typeof ACTIVITY_WINDOW

export function visibleOrder(data: OrderData, showSettled: boolean, view: ListView): readonly SessionLocation[] {
  const shown: Shown[] = []
  for (const entry of data.entries.values()) {
    if (entry.kind === "tombstone") continue
    if (entry.row.archivedAt !== undefined || entry.row.parentSessionId !== undefined) continue
    if (!showSettled && entrySettled(entry, readerOf(data, entry.row.ref.sessionId))) continue
    const key = orderKey(entry.row, entryActivityAt(entry))
    if (entry.kind === "confirmed" && !insideListWindow(data, view === "projects" ? entry.row.ref.projectId : ACTIVITY_WINDOW, key)) continue
    shown.push({ entry, key })
  }
  return shown.sort((a, b) => compareOrder(a.key, b.key)).map(({ entry }) => entry.row.ref)
}

function cachedView(
  hit: CachedView | undefined,
  entry: ConfirmedEntry | PendingEntry,
  reader: SessionReader,
  status: SessionStatusView,
  waitingOnUser: boolean,
): CachedView {
  if (hit && hit.entry === entry && hit.reader === reader && hit.status === status && hit.waitingOnUser === waitingOnUser) return hit
  const view: SessionRowView = { ...entry.row, ...reader, status, waitingOnUser, pending: entry.kind === "pending", settled: entrySettled(entry, reader) }
  return { entry, reader, status, waitingOnUser, view }
}

export function rowViews(input: {
  readonly order: readonly SessionLocation[]
  readonly data: Pick<ListData, "entries" | "statuses" | "backgroundWork" | "readers">
  readonly openRequests: ReadonlyMap<SessionId, readonly AgentRequest[]>
  readonly cache: RowViewCache
}): ReadonlyMap<SessionId, SessionRowView> {
  const next = new Map<SessionId, CachedView>()
  const views = new Map<SessionId, SessionRowView>()
  for (const ref of input.order) {
    const id = ref.sessionId
    const entry = input.data.entries.get(id)
    if (!entry || entry.kind === "tombstone") continue
    const status = sessionStatusWithBackgroundWork(input.data.statuses.get(id)?.status ?? UNKNOWN_STATUS, input.data.backgroundWork.get(id)?.work ?? NO_BACKGROUND_WORK)
    const waitingOnUser = (input.openRequests.get(id)?.length ?? 0) > 0 || input.data.statuses.get(id)?.waitingOnUser === true
    const cached = cachedView(input.cache.current.get(id), entry, readerOf(input.data, id), status, waitingOnUser)
    next.set(id, cached)
    views.set(id, cached.view)
  }
  input.cache.current = next
  return views
}
