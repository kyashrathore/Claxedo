import { createMemo } from "solid-js"
import { machine, type Machine } from "@/lib/machine"
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
} from "@/server"
import type { LoadMoreState, SessionList, SessionListState, SessionStatusView } from "@/session"
import { toAppError, type RequestsInternal } from "../requests"
import { initialListState, type ListEvent, type ListState } from "./model"
import { createListReads, type ListReads } from "./reads"
import { transition } from "./transition"
import { createRowViewCache, UNKNOWN_STATUS, visibleRows } from "./visible-rows"

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
  return { ref, title: input.title ?? "", createdAt: at, updatedAt: at, harness: input.harness }
}

async function createSession(server: Server, list: Machine<ListState, ListEvent>, input: SessionCreateInput): Promise<SessionRef> {
  const placement = server.placements.byId(input.placementId)
  if (!placement) throw unknownPlacement(input.placementId)
  const clientRequestId = uuid()
  const ref: SessionRef = { projectId: placement.projectId, placementId: placement.id, sessionId: asSessionId(`pending:${clientRequestId}`) }
  list.send({ type: "createStarted", clientRequestId, row: pendingRow(ref, input, Date.now()) })
  try {
    const created = await server.sessions.create(input)
    list.send({ type: "createConfirmed", clientRequestId, row: created })
    return created.ref
  } catch (cause) {
    list.send({ type: "createFailed", clientRequestId })
    throw toAppError(cause)
  }
}

function applyServerEvent(list: Machine<ListState, ListEvent>, reads: ListReads, event: ServerEvent): void {
  switch (event.type) {
    case "sessionUpserted":
      return list.send(event)
    case "sessionRemoved":
      return list.send({ type: "sessionRemoved", ref: event.ref, at: Date.now() })
    case "statusChanged":
      return list.send({ type: "statusChanged", ref: event.ref, status: event.status, at: Date.now() })
    case "streamGap":
      return reads.requestReread("replace")
    case "sessionsChanged":
      return reads.requestReread("refresh")
    default:
      return
  }
}

function rowOf(state: ListState, sessionId: SessionId): SessionRow | undefined {
  const entry = state.entries.get(sessionId)
  return entry && entry.kind !== "tombstone" ? entry.row : undefined
}

export function createSessionList(server: Server, requests: RequestsInternal): SessionListInternal {
  const list = machine(initialListState, transition)
  const reads = createListReads(server, requests, list)
  const cache = createRowViewCache()
  const { state, send } = list
  return {
    state: createMemo(() => publicState(state())),
    rows: createMemo(() => visibleRows(state(), requests.openBySession(), cache)),
    hasMore: () => state().nextCursor !== undefined,
    moreState: createMemo(() => moreState(state())),
    loadMore: reads.loadMore,
    reload: () => reads.reread("replace"),
    create: (input) => createSession(server, list, input),
    start: () => void reads.fetchFirst(),
    rowOf: (sessionId) => rowOf(state(), sessionId),
    statusOf: (sessionId) => state().statuses.get(sessionId)?.status ?? UNKNOWN_STATUS,
    apply: (event) => applyServerEvent(list, reads, event),
    readRow: (row) => send({ type: "rowRead", row }),
    readStatus: (ref, status, sentAt) => send({ type: "statusRead", ref, status, sentAt }),
    opened: (sessionId) => send({ type: "sessionOpened", sessionId }),
    closed: (sessionId) => send({ type: "sessionClosed", sessionId }),
    sendStarted: (sessionId, clientRequestId, at) => send({ type: "sendStarted", sessionId, clientRequestId, at }),
    sendFailed: (sessionId, clientRequestId) => send({ type: "sendFailed", sessionId, clientRequestId }),
  }
}
