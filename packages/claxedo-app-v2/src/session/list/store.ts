import { createMemo, createSignal, type Accessor } from "solid-js"
import { machine } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import {
  sessionId as asSessionId,
  type AppError,
  type PlacementId,
  type Server,
  type ServerEvent,
  type SessionCreateInput,
  type SessionId,
  type SessionRef,
  type SessionRow,
  type SessionStatus,
  type SessionStatusRead,
} from "@/server"
import type { LoadMoreState, SessionList, SessionListState, SessionStatusView } from "@/session"
import { toAppError, type RequestsInternal } from "../requests"
import { initialListState, type FetchedWindow, type ListState } from "./model"
import { transition } from "./transition"
import { createRowViewCache, UNKNOWN_STATUS, visibleRows } from "./visible-rows"

export const PAGE_SIZE = 50

export type SessionListInternal = SessionList & {
  readonly start: () => void
  readonly rowOf: (sessionId: SessionId) => SessionRow | undefined
  readonly statusOf: (sessionId: SessionId) => SessionStatusView
  readonly apply: (event: ServerEvent) => void
  readonly readRow: (row: SessionRow) => void
  readonly readStatus: (ref: SessionRef, status: SessionStatus, sentAt: number) => void
  readonly opened: (sessionId: SessionId) => void
  readonly closed: (sessionId: SessionId) => void
  readonly sendStarted: (sessionId: SessionId, clientRequestId: string, at: number) => void
  readonly sendFailed: (sessionId: SessionId, clientRequestId: string) => void
}

const PUBLIC_STATE: Record<"subscribing" | "fetching" | "live" | "rereading", SessionListState> = {
  subscribing: { kind: "subscribing" },
  fetching: { kind: "fetching" },
  live: { kind: "live" },
  rereading: { kind: "rereading" },
}

const MORE_IDLE: LoadMoreState = { kind: "idle" }
const MORE_LOADING: LoadMoreState = { kind: "loading" }

function publicState(state: ListState): SessionListState {
  if (state.kind === "failed") return { kind: "failed", message: state.error.message, error: state.error }
  return PUBLIC_STATE[state.kind]
}

function moreState(state: ListState): LoadMoreState {
  if (state.kind !== "live") return MORE_IDLE
  if (state.more.kind === "loading") return MORE_LOADING
  return state.more.kind === "failed" ? { kind: "failed", error: state.more.error } : MORE_IDLE
}

const unknownPlacement = (placementId: PlacementId): AppError => ({
  class: "not_found",
  message: `unknown placement ${placementId}`,
  retryable: false,
})

function pendingRow(ref: SessionRef, input: SessionCreateInput, at: number): SessionRow {
  return { ref, title: input.title ?? "", createdAt: at, updatedAt: at, lastHumanTurnAt: at, harness: input.harness }
}

export function createSessionList(server: Server, requests: RequestsInternal): SessionListInternal {
  const list = machine(initialListState, transition)
  const state = list.state
  const send = list.send
  const cache = createRowViewCache()
  const [gapPending, setGapPending] = createSignal(false)
  const rows = createMemo(() => visibleRows(state(), requests.openBySession(), cache))
  const shown: Accessor<SessionListState> = createMemo(() => publicState(state()))
  const more: Accessor<LoadMoreState> = createMemo(() => moreState(state()))

  function readRequests(fetched: readonly SessionRow[], read: SessionStatusRead, sentAt: number): void {
    const reported = new Set(read.reports.map((report) => report.ref.sessionId))
    requests.applyReads(read.reports, sentAt)
    for (const row of fetched) if (!reported.has(row.ref.sessionId)) requests.read(row.ref, [], sentAt)
  }

  async function readWindow(cursor: string | undefined, withStatuses: boolean): Promise<FetchedWindow> {
    const sentAt = Date.now()
    const [page, statuses] = await Promise.all([
      server.sessions.list({ cursor, limit: PAGE_SIZE }),
      withStatuses ? server.sessions.statuses() : undefined,
    ])
    if (statuses) readRequests(page.rows, statuses, sentAt)
    return { rows: page.rows, nextCursor: page.nextCursor, sentAt, statuses }
  }

  function afterRead(): void {
    if (!gapPending()) return
    setGapPending(false)
    void reload()
  }

  async function fetchFirst(): Promise<void> {
    send({ type: "fetchStarted" })
    try {
      send({ type: "fetched", window: await readWindow(undefined, true) })
    } catch (cause) {
      send({ type: "fetchFailed", error: toAppError(cause) })
    }
    afterRead()
  }

  async function loadMore(): Promise<void> {
    const current = state()
    if (current.kind !== "live" || current.more.kind === "loading" || current.nextCursor === undefined) return
    send({ type: "moreStarted" })
    try {
      send({ type: "moreFetched", window: await readWindow(current.nextCursor, false) })
    } catch (cause) {
      send({ type: "moreFailed", error: toAppError(cause) })
    }
    afterRead()
  }

  async function reload(): Promise<void> {
    const kind = state().kind
    if (kind !== "live" && kind !== "failed") return
    send({ type: "rereadStarted" })
    try {
      send({ type: "rereadFetched", window: await readWindow(undefined, true) })
    } catch (cause) {
      send({ type: "rereadFailed", error: toAppError(cause) })
    }
    afterRead()
  }

  function gap(): void {
    const current = state()
    const reading = current.kind === "fetching" || current.kind === "rereading" || (current.kind === "live" && current.more.kind === "loading")
    if (reading) setGapPending(true)
    else void reload()
  }

  async function create(input: SessionCreateInput): Promise<SessionRef> {
    const placement = server.placements.byId(input.placementId)
    if (!placement) throw unknownPlacement(input.placementId)
    const clientRequestId = uuid()
    const ref: SessionRef = { projectId: placement.projectId, placementId: placement.id, sessionId: asSessionId(`pending:${clientRequestId}`) }
    send({ type: "createStarted", clientRequestId, row: pendingRow(ref, input, Date.now()) })
    try {
      const created = await server.sessions.create(input)
      send({ type: "createConfirmed", clientRequestId, row: created })
      return created.ref
    } catch (cause) {
      send({ type: "createFailed", clientRequestId })
      throw toAppError(cause)
    }
  }

  function apply(event: ServerEvent): void {
    switch (event.type) {
      case "sessionUpserted":
        return send(event)
      case "sessionRemoved":
        return send({ type: "sessionRemoved", ref: event.ref, at: Date.now() })
      case "statusChanged":
        return send({ type: "statusChanged", ref: event.ref, status: event.status, at: Date.now() })
      case "streamGap":
        return gap()
      default:
        return
    }
  }

  function rowOf(sessionId: SessionId): SessionRow | undefined {
    const entry = state().entries.get(sessionId)
    return entry && entry.kind !== "tombstone" ? entry.row : undefined
  }

  return {
    state: shown,
    rows,
    hasMore: () => state().nextCursor !== undefined,
    moreState: more,
    loadMore,
    reload,
    create,
    start: () => void fetchFirst(),
    rowOf,
    statusOf: (sessionId) => state().statuses.get(sessionId)?.status ?? UNKNOWN_STATUS,
    apply,
    readRow: (row) => send({ type: "rowRead", row }),
    readStatus: (ref, status, sentAt) => send({ type: "statusRead", ref, status, sentAt }),
    opened: (sessionId) => send({ type: "sessionOpened", sessionId }),
    closed: (sessionId) => send({ type: "sessionClosed", sessionId }),
    sendStarted: (sessionId, clientRequestId, at) => send({ type: "sendStarted", sessionId, clientRequestId, at }),
    sendFailed: (sessionId, clientRequestId) => send({ type: "sendFailed", sessionId, clientRequestId }),
  }
}
