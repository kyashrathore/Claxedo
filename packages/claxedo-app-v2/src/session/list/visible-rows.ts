import type { AgentRequest, SessionId, SessionRef } from "@/server"
import type { SessionRowView, SessionStatusView } from "@/session"
import {
  compareOrder,
  entryActivityAt,
  insidePlacementWindow,
  orderKey,
  type ConfirmedEntry,
  type ListState,
  type OrderKey,
  type PendingEntry,
} from "./model"

type Shown = { readonly entry: ConfirmedEntry | PendingEntry; readonly key: OrderKey }

type CachedView = {
  readonly entry: ConfirmedEntry | PendingEntry
  readonly status: SessionStatusView
  readonly waitingOnUser: boolean
  readonly view: SessionRowView
}

export type RowViewCache = { current: ReadonlyMap<SessionId, CachedView> }

export const UNKNOWN_STATUS: SessionStatusView = { kind: "unknown" }

export const createRowViewCache = (): RowViewCache => ({ current: new Map() })

function shownEntries(state: ListState): Shown[] {
  const shown: Shown[] = []
  for (const entry of state.entries.values()) {
    if (entry.kind === "tombstone") continue
    if (entry.row.archivedAt !== undefined || entry.row.parentSessionId !== undefined) continue
    const key = orderKey(entry.row, entryActivityAt(entry))
    if (entry.kind === "confirmed" && !insidePlacementWindow(state, entry.row, key)) continue
    shown.push({ entry, key })
  }
  return shown.sort((a, b) => compareOrder(a.key, b.key))
}

function cachedView(
  hit: CachedView | undefined,
  entry: ConfirmedEntry | PendingEntry,
  status: SessionStatusView,
  waitingOnUser: boolean,
): CachedView {
  if (hit && hit.entry === entry && hit.status === status && hit.waitingOnUser === waitingOnUser) return hit
  const view: SessionRowView = { ...entry.row, status, waitingOnUser, pending: entry.kind === "pending" }
  return { entry, status, waitingOnUser, view }
}

export type VisibleRows = {
  readonly views: readonly SessionRowView[]
  readonly byId: ReadonlyMap<SessionId, SessionRowView>
}

export function visibleRows(
  state: ListState,
  openRequests: ReadonlyMap<SessionId, readonly AgentRequest[]>,
  cache: RowViewCache,
): VisibleRows {
  const next = new Map<SessionId, CachedView>()
  const byId = new Map<SessionId, SessionRowView>()
  const views = shownEntries(state).map(({ entry }) => {
    const id = entry.row.ref.sessionId
    const status = state.statuses.get(id)?.status ?? UNKNOWN_STATUS
    const waitingOnUser = (openRequests.get(id)?.length ?? 0) > 0
    const cached = cachedView(cache.current.get(id), entry, status, waitingOnUser)
    next.set(id, cached)
    byId.set(id, cached.view)
    return cached.view
  })
  cache.current = next
  return { views, byId }
}

export const sameItems = <T>(previous: readonly T[], next: readonly T[]) =>
  previous.length === next.length && previous.every((item, index) => item === next[index])

export const sameSessions = (previous: readonly SessionRef[], next: readonly SessionRef[]) =>
  previous.length === next.length && previous.every((ref, index) => ref.sessionId === next[index]?.sessionId)
