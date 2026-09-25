import type { AgentRequest, SessionId, SessionRef } from "@/server"
import type { SessionRowView, SessionStatusView } from "@/session"
import {
  compareOrder,
  entryActivityAt,
  insidePlacementWindow,
  orderKey,
  type ConfirmedEntry,
  type ListData,
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

type OrderData = Pick<ListData, "entries" | "windows">

export function visibleOrder(data: OrderData): readonly SessionRef[] {
  const shown: Shown[] = []
  for (const entry of data.entries.values()) {
    if (entry.kind === "tombstone") continue
    if (entry.row.archivedAt !== undefined || entry.row.parentSessionId !== undefined) continue
    const key = orderKey(entry.row, entryActivityAt(entry))
    if (entry.kind === "confirmed" && !insidePlacementWindow(data, entry.row, key)) continue
    shown.push({ entry, key })
  }
  return shown.sort((a, b) => compareOrder(a.key, b.key)).map(({ entry }) => entry.row.ref)
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

export function rowViews(input: {
  readonly order: readonly SessionRef[]
  readonly data: Pick<ListData, "entries" | "statuses">
  readonly openRequests: ReadonlyMap<SessionId, readonly AgentRequest[]>
  readonly cache: RowViewCache
}): ReadonlyMap<SessionId, SessionRowView> {
  const next = new Map<SessionId, CachedView>()
  const views = new Map<SessionId, SessionRowView>()
  for (const ref of input.order) {
    const id = ref.sessionId
    const entry = input.data.entries.get(id)
    if (!entry || entry.kind === "tombstone") continue
    const status = input.data.statuses.get(id)?.status ?? UNKNOWN_STATUS
    const waitingOnUser = (input.openRequests.get(id)?.length ?? 0) > 0
    const cached = cachedView(input.cache.current.get(id), entry, status, waitingOnUser)
    next.set(id, cached)
    views.set(id, cached.view)
  }
  input.cache.current = next
  return views
}
