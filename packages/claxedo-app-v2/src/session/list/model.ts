import { unreachable } from "@/lib/machine"
import type { AppError, PlacementId, SessionId, SessionRef, SessionRow, SessionStatus, SessionStatusRead } from "@/server"

export type PendingSend = {
  readonly clientRequestId: string
  readonly at: number
  readonly updatedBefore: number
}

export type OrderKey = { readonly activity: number; readonly createdAt: number; readonly sessionId: string }

export type ConfirmedEntry = {
  readonly kind: "confirmed"
  readonly row: SessionRow
  readonly pendingSend?: PendingSend
}

export type PendingEntry = {
  readonly kind: "pending"
  readonly clientRequestId: string
  readonly row: SessionRow
}

export type TombstoneEntry = { readonly kind: "tombstone"; readonly ref: SessionRef; readonly at: number }

export type ListEntry = ConfirmedEntry | PendingEntry | TombstoneEntry

export type StatusEntry = {
  readonly status: SessionStatus
  readonly at: number
  readonly source: "event" | "read"
}

export type UnreportedStatus = {
  readonly status: SessionStatus
  readonly sentAt: number
  readonly unreadPlacements: ReadonlySet<PlacementId>
}

export type FetchedPage = {
  readonly placementId: PlacementId
  readonly rows: readonly SessionRow[]
  readonly nextCursor: string | undefined
}

export type FetchedWindow = {
  readonly pages: readonly FetchedPage[]
  readonly sentAt: number
  readonly statuses: SessionStatusRead | undefined
}

export type PlacementWindow = { readonly tail: OrderKey; readonly nextCursor: string | undefined }

export type ListData = {
  readonly entries: ReadonlyMap<SessionId, ListEntry>
  readonly statuses: ReadonlyMap<SessionId, StatusEntry>
  readonly unreported: UnreportedStatus | undefined
  readonly open: ReadonlySet<SessionId>
  readonly windows: ReadonlyMap<PlacementId, PlacementWindow>
}

export type ServerListEvent =
  | { readonly type: "sessionUpserted"; readonly row: SessionRow }
  | { readonly type: "sessionRemoved"; readonly ref: SessionRef; readonly at: number }
  | { readonly type: "statusChanged"; readonly ref: SessionRef; readonly status: SessionStatus; readonly at: number }

export type MorePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly held: readonly ServerListEvent[] }
  | { readonly kind: "failed"; readonly error: AppError }

export type ListState = ListData &
  (
    | { readonly kind: "subscribing" }
    | { readonly kind: "fetching"; readonly held: readonly ServerListEvent[] }
    | { readonly kind: "live"; readonly more: MorePhase }
    | { readonly kind: "rereading"; readonly held: readonly ServerListEvent[] }
    | { readonly kind: "failed"; readonly error: AppError }
  )

export type RereadMode = "replace" | "refresh"

export type FollowUp = { readonly kind: "none" } | { readonly kind: "waiting"; readonly mode: RereadMode }

export type FollowUpEvent = { readonly type: "requested"; readonly mode: RereadMode } | { readonly type: "taken" }

export const NO_FOLLOW_UP: FollowUp = { kind: "none" }

export function followUpTransition(state: FollowUp, event: FollowUpEvent): FollowUp {
  switch (event.type) {
    case "requested":
      return state.kind === "waiting" && state.mode === "replace" ? state : { kind: "waiting", mode: event.mode }
    case "taken":
      return NO_FOLLOW_UP
    default:
      return unreachable(event)
  }
}

export type ListEvent =
  | ServerListEvent
  | { readonly type: "fetchStarted" }
  | { readonly type: "fetched"; readonly window: FetchedWindow }
  | { readonly type: "fetchFailed"; readonly error: AppError }
  | { readonly type: "moreStarted"; readonly placementIds: readonly PlacementId[] }
  | { readonly type: "moreFetched"; readonly window: FetchedWindow }
  | { readonly type: "moreFailed"; readonly error: AppError }
  | { readonly type: "rereadStarted" }
  | { readonly type: "rereadFetched"; readonly window: FetchedWindow; readonly mode: RereadMode }
  | { readonly type: "rereadFailed"; readonly error: AppError }
  | { readonly type: "rowRead"; readonly row: SessionRow }
  | { readonly type: "statusRead"; readonly ref: SessionRef; readonly status: SessionStatus; readonly sentAt: number }
  | { readonly type: "statusesFetched"; readonly read: SessionStatusRead; readonly sentAt: number; readonly rows: readonly SessionRow[] }
  | { readonly type: "sessionOpened"; readonly sessionId: SessionId }
  | { readonly type: "sessionClosed"; readonly sessionId: SessionId }
  | { readonly type: "createStarted"; readonly clientRequestId: string; readonly row: SessionRow }
  | { readonly type: "createConfirmed"; readonly clientRequestId: string; readonly row: SessionRow }
  | { readonly type: "createFailed"; readonly clientRequestId: string }
  | { readonly type: "sendStarted"; readonly sessionId: SessionId; readonly clientRequestId: string; readonly at: number }
  | { readonly type: "sendFailed"; readonly sessionId: SessionId; readonly clientRequestId: string }

export const WINDOW_EMPTY: OrderKey = { activity: Number.POSITIVE_INFINITY, createdAt: Number.POSITIVE_INFINITY, sessionId: "" }

export const WINDOW_ALL: OrderKey = { activity: Number.NEGATIVE_INFINITY, createdAt: Number.NEGATIVE_INFINITY, sessionId: "" }

export const initialListState: ListState = {
  kind: "subscribing",
  entries: new Map(),
  statuses: new Map(),
  unreported: undefined,
  open: new Set(),
  windows: new Map(),
}

const rowActivityAt = (row: SessionRow): number => row.lastHumanTurnAt ?? 0

export function entryActivityAt(entry: ConfirmedEntry | PendingEntry): number {
  if (entry.kind === "confirmed" && entry.pendingSend) return Math.max(rowActivityAt(entry.row), entry.pendingSend.at)
  return rowActivityAt(entry.row)
}

export const orderKey = (row: SessionRow, activity: number = rowActivityAt(row)): OrderKey => ({
  activity,
  createdAt: row.createdAt,
  sessionId: row.ref.sessionId,
})

export function compareOrder(a: OrderKey, b: OrderKey): number {
  if (a.activity !== b.activity) return b.activity - a.activity
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return b.sessionId.localeCompare(a.sessionId)
}

export const insideWindow = (key: OrderKey, tail: OrderKey): boolean => compareOrder(key, tail) <= 0

export const windowTail = (data: ListData, placementId: PlacementId): OrderKey => data.windows.get(placementId)?.tail ?? WINDOW_EMPTY

export const insidePlacementWindow = (data: ListData, row: SessionRow, key: OrderKey = orderKey(row)): boolean =>
  insideWindow(key, windowTail(data, row.ref.placementId))

export const windowRows = (window: FetchedWindow): readonly SessionRow[] => window.pages.flatMap((page) => page.rows)

export const listedRows = (data: ListData): readonly SessionRow[] =>
  [...data.entries.values()].flatMap((entry) => (entry.kind === "confirmed" ? [entry.row] : []))

export const hasMorePages = (windows: ListData["windows"], placementIds: readonly PlacementId[]): boolean =>
  placementIds.some((id) => windows.get(id)?.nextCursor !== undefined)

function laterHumanTurn(current: SessionRow, incoming: SessionRow): number | undefined {
  if (current.lastHumanTurnAt === undefined) return incoming.lastHumanTurnAt
  if (incoming.lastHumanTurnAt === undefined) return current.lastHumanTurnAt
  return Math.max(current.lastHumanTurnAt, incoming.lastHumanTurnAt)
}

export function newerRow(current: SessionRow, incoming: SessionRow): SessionRow | undefined {
  if (incoming.updatedAt < current.updatedAt) return undefined
  const lastHumanTurnAt = laterHumanTurn(current, incoming)
  const lastTurn = incoming.lastTurn ?? current.lastTurn
  if (incoming.createdAt === current.createdAt && incoming.lastHumanTurnAt === lastHumanTurnAt && incoming.lastTurn === lastTurn) return incoming
  return {
    ...incoming,
    createdAt: current.createdAt,
    ...(lastHumanTurnAt === undefined ? {} : { lastHumanTurnAt }),
    ...(lastTurn === undefined ? {} : { lastTurn }),
  }
}
