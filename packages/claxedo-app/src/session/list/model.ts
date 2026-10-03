import { unreachable } from "@/lib/machine"
import { turnDetailed, type AppError, type BackgroundWork, type ListedStatus, type ProjectId, type SessionId, type SessionLocation, type SessionReader, type SessionRow, type SessionSelections, type SessionStatus } from "@/server"
import type { SessionLastTurn } from "@claxedo/agent-runtime-contract"

export type PendingSend = {
  readonly clientRequestId: string
  readonly at: number
  readonly updatedBefore: number
}

export type OrderKey = { readonly activity: number; readonly createdAt: number; readonly sessionId: string }

export const ACTIVITY_WINDOW: "activity" = "activity"

export type WindowKey = ProjectId | typeof ACTIVITY_WINDOW

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

export type TombstoneEntry = { readonly kind: "tombstone"; readonly ref: SessionLocation; readonly at: number }

export type ListEntry = ConfirmedEntry | PendingEntry | TombstoneEntry

export type StatusEntry = {
  readonly status: SessionStatus
  readonly at: number
  readonly source: "event" | "read"
  readonly waitingOnUser: boolean
}

export type BackgroundWorkEntry = {
  readonly work: BackgroundWork
  readonly at: number
  readonly source: "event" | "read"
}

export type ReaderEntry = {
  readonly reader: SessionReader
  readonly at: number
  readonly source: "event" | "read"
  readonly pending?: { readonly writeId: string; readonly reader: SessionReader }
}

export type FetchedPage = {
  readonly windowKey: WindowKey
  readonly rows: readonly SessionRow[]
  readonly statuses: ReadonlyMap<SessionId, ListedStatus>
  readonly readers: ReadonlyMap<SessionId, SessionReader>
  readonly nextAfter: string | undefined
  readonly degraded: boolean
}

export type FailedPage = { readonly windowKey: WindowKey; readonly error: AppError }

export type FetchedWindow = {
  readonly pages: readonly FetchedPage[]
  readonly failures: readonly FailedPage[]
  readonly sentAt: number
}

export type ListWindow = { readonly tail: OrderKey; readonly nextAfter: string | undefined }

export type ListData = {
  readonly entries: ReadonlyMap<SessionId, ListEntry>
  readonly statuses: ReadonlyMap<SessionId, StatusEntry>
  readonly backgroundWork: ReadonlyMap<SessionId, BackgroundWorkEntry>
  readonly readers: ReadonlyMap<SessionId, ReaderEntry>
  readonly open: ReadonlySet<SessionId>
  readonly windows: ReadonlyMap<WindowKey, ListWindow>
  readonly failures: ReadonlyMap<WindowKey, AppError>
  readonly degraded: ReadonlySet<WindowKey>
}

export type ServerListEvent =
  | { readonly type: "sessionUpserted"; readonly row: SessionRow }
  | { readonly type: "sessionRemoved"; readonly ref: SessionLocation; readonly at: number }
  | {
      readonly type: "statusChanged"
      readonly ref: SessionLocation
      readonly status: SessionStatus
      readonly lastTurn?: SessionLastTurn
      readonly waitingOnUser?: boolean
      readonly at: number
    }
  | { readonly type: "backgroundWorkChanged"; readonly ref: SessionLocation; readonly work: BackgroundWork; readonly at: number }
  | { readonly type: "readerChanged"; readonly ref: SessionLocation; readonly reader: SessionReader; readonly at: number }

export type MorePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly held: readonly ServerListEvent[] }
  | { readonly kind: "failed"; readonly error: AppError }

export type ListState = ListData &
  (
    | { readonly kind: "subscribing" }
    | { readonly kind: "fetching"; readonly held: readonly ServerListEvent[] }
    | { readonly kind: "live"; readonly more: ReadonlyMap<WindowKey, MorePhase> }
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
  | { readonly type: "moreStarted"; readonly windowKey: WindowKey }
  | { readonly type: "moreFetched"; readonly windowKey: WindowKey; readonly window: FetchedWindow }
  | { readonly type: "moreFailed"; readonly windowKey: WindowKey; readonly error: AppError }
  | { readonly type: "rereadStarted" }
  | { readonly type: "rereadFetched"; readonly window: FetchedWindow; readonly mode: RereadMode }
  | { readonly type: "rereadFailed"; readonly error: AppError }
  | { readonly type: "rowRead"; readonly row: SessionRow }
  | { readonly type: "rowsFetched"; readonly window: FetchedWindow }
  | { readonly type: "statusRead"; readonly ref: SessionLocation; readonly status: SessionStatus; readonly sentAt: number }
  | { readonly type: "backgroundWorkRead"; readonly ref: SessionLocation; readonly work: BackgroundWork; readonly sentAt: number }
  | { readonly type: "sessionOpened"; readonly sessionId: SessionId }
  | { readonly type: "sessionClosed"; readonly sessionId: SessionId }
  | { readonly type: "createStarted"; readonly clientRequestId: string; readonly row: SessionRow }
  | { readonly type: "createConfirmed"; readonly clientRequestId: string; readonly row: SessionRow }
  | { readonly type: "createFailed"; readonly clientRequestId: string }
  | { readonly type: "sendStarted"; readonly sessionId: SessionId; readonly clientRequestId: string; readonly at: number }
  | { readonly type: "sendFailed"; readonly sessionId: SessionId; readonly clientRequestId: string }
  | { readonly type: "readerWriteStarted"; readonly sessionId: SessionId; readonly writeId: string; readonly reader: SessionReader }
  | { readonly type: "readerWritten"; readonly sessionId: SessionId; readonly writeId: string; readonly reader: SessionReader; readonly at: number }
  | { readonly type: "readerWriteFailed"; readonly sessionId: SessionId; readonly writeId: string }

export const WINDOW_EMPTY: OrderKey = { activity: Number.POSITIVE_INFINITY, createdAt: Number.POSITIVE_INFINITY, sessionId: "" }

export const WINDOW_ALL: OrderKey = { activity: Number.NEGATIVE_INFINITY, createdAt: Number.NEGATIVE_INFINITY, sessionId: "" }

export const initialListState: ListState = {
  kind: "subscribing",
  entries: new Map(),
  statuses: new Map(),
  backgroundWork: new Map(),
  readers: new Map(),
  open: new Set(),
  windows: new Map(),
  failures: new Map(),
  degraded: new Set(),
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

export const windowTail = (data: Pick<ListData, "windows">, windowKey: WindowKey): OrderKey => data.windows.get(windowKey)?.tail ?? WINDOW_EMPTY

export const insideListWindow = (data: Pick<ListData, "windows">, windowKey: WindowKey, key: OrderKey): boolean => insideWindow(key, windowTail(data, windowKey))

export const windowsHolding = (data: Pick<ListData, "windows">, row: SessionRow, key: OrderKey = orderKey(row)): readonly WindowKey[] =>
  [row.ref.projectId, ACTIVITY_WINDOW].filter((windowKey) => insideListWindow(data, windowKey, key))

export const hasMorePages = (windows: ListData["windows"], windowKey: WindowKey): boolean => windows.get(windowKey)?.nextAfter !== undefined

export const canReadPage = (windows: ListData["windows"], windowKey: WindowKey): boolean => !windows.has(windowKey) || hasMorePages(windows, windowKey)

function laterHumanTurn(current: SessionRow, incoming: SessionRow): number | undefined {
  if (current.lastHumanTurnAt === undefined) return incoming.lastHumanTurnAt
  if (incoming.lastHumanTurnAt === undefined) return current.lastHumanTurnAt
  return Math.max(current.lastHumanTurnAt, incoming.lastHumanTurnAt)
}

function withSelections(row: SessionRow, from: SessionSelections): SessionRow {
  const { harness: _harness, model: _model, permissionMode: _permissionMode, permissionModeLabel: _permissionModeLabel, ...rest } = row
  return {
    ...rest,
    ...(from.harness ? { harness: from.harness } : {}),
    ...(from.model ? { model: from.model } : {}),
    ...(from.permissionMode ? { permissionMode: from.permissionMode } : {}),
    ...(from.permissionModeLabel ? { permissionModeLabel: from.permissionModeLabel } : {}),
  }
}

export function laterTurn(held: SessionRow["lastTurn"], incoming: SessionRow["lastTurn"]): SessionRow["lastTurn"] {
  if (!incoming) return held
  if (!held || incoming.completedAt > held.completedAt) return incoming
  const sameTurn = incoming.completedAt === held.completedAt && incoming.status === held.status
  return sameTurn && turnDetailed(incoming) && !turnDetailed(held) ? incoming : held
}

export function newerRow(current: SessionRow, incoming: SessionRow): SessionRow | undefined {
  if (incoming.updatedAt < current.updatedAt) return undefined
  const lastHumanTurnAt = laterHumanTurn(current, incoming)
  const lastTurn = laterTurn(current.lastTurn, incoming.lastTurn)
  const configured = incoming.harness || !current.harness ? incoming : current
  if (incoming.createdAt === current.createdAt && incoming.lastHumanTurnAt === lastHumanTurnAt && incoming.lastTurn === lastTurn && configured === incoming) return incoming
  return withSelections(
    {
      ...incoming,
      createdAt: current.createdAt,
      ...(lastHumanTurnAt === undefined ? {} : { lastHumanTurnAt }),
      ...(lastTurn === undefined ? {} : { lastTurn }),
    },
    configured,
  )
}
