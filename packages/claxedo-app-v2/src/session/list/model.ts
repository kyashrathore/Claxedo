import type { AppError, SessionId, SessionRef, SessionRow, SessionStatus, SessionStatusRead } from "@/server"

export type PendingSend = { readonly clientRequestId: string; readonly at: number }

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

export type UnreportedStatus = { readonly status: SessionStatus; readonly sentAt: number }

export type FetchedWindow = {
  readonly rows: readonly SessionRow[]
  readonly nextCursor: string | undefined
  readonly sentAt: number
  readonly statuses: SessionStatusRead | undefined
}

export type ListData = {
  readonly entries: ReadonlyMap<SessionId, ListEntry>
  readonly statuses: ReadonlyMap<SessionId, StatusEntry>
  readonly unreported: UnreportedStatus | undefined
  readonly open: ReadonlySet<SessionId>
  readonly windowTail: number
  readonly nextCursor: string | undefined
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

export type ListEvent =
  | ServerListEvent
  | { readonly type: "fetchStarted" }
  | { readonly type: "fetched"; readonly window: FetchedWindow }
  | { readonly type: "fetchFailed"; readonly error: AppError }
  | { readonly type: "moreStarted" }
  | { readonly type: "moreFetched"; readonly window: FetchedWindow }
  | { readonly type: "moreFailed"; readonly error: AppError }
  | { readonly type: "rereadStarted" }
  | { readonly type: "rereadFetched"; readonly window: FetchedWindow }
  | { readonly type: "rereadFailed"; readonly error: AppError }
  | { readonly type: "rowRead"; readonly row: SessionRow }
  | { readonly type: "statusRead"; readonly ref: SessionRef; readonly status: SessionStatus; readonly sentAt: number }
  | { readonly type: "sessionOpened"; readonly sessionId: SessionId }
  | { readonly type: "sessionClosed"; readonly sessionId: SessionId }
  | { readonly type: "createStarted"; readonly clientRequestId: string; readonly row: SessionRow }
  | { readonly type: "createConfirmed"; readonly clientRequestId: string; readonly row: SessionRow }
  | { readonly type: "createFailed"; readonly clientRequestId: string }
  | { readonly type: "sendStarted"; readonly sessionId: SessionId; readonly clientRequestId: string; readonly at: number }
  | { readonly type: "sendFailed"; readonly sessionId: SessionId; readonly clientRequestId: string }

export const initialListState: ListState = {
  kind: "subscribing",
  entries: new Map(),
  statuses: new Map(),
  unreported: undefined,
  open: new Set(),
  windowTail: Number.POSITIVE_INFINITY,
  nextCursor: undefined,
}

export const rowActivityAt = (row: SessionRow): number => row.lastHumanTurnAt ?? row.createdAt

export function entryActivityAt(entry: ConfirmedEntry | PendingEntry): number {
  if (entry.kind === "confirmed" && entry.pendingSend) return Math.max(rowActivityAt(entry.row), entry.pendingSend.at)
  return rowActivityAt(entry.row)
}

export function newerRow(current: SessionRow, incoming: SessionRow): SessionRow | undefined {
  if (incoming.updatedAt < current.updatedAt) return undefined
  if (current.lastHumanTurnAt === undefined) return incoming
  if (incoming.lastHumanTurnAt !== undefined && incoming.lastHumanTurnAt >= current.lastHumanTurnAt) return incoming
  return { ...incoming, lastHumanTurnAt: current.lastHumanTurnAt }
}
