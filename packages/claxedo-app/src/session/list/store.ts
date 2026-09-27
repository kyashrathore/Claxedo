import { createMemo, type Accessor } from "solid-js"
import { harnessSelectionOf } from "@/lib/harness-selection"
import { machine, type Machine } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import {
  sessionId as asSessionId,
  toAppError,
  type AppError,
  type PlacementId,
  type ProjectId,
  type Server,
  type ServerEvent,
  type SessionCreateInput,
  type SessionId,
  type SessionRef,
  type SessionRow,
  type SessionStatus,
} from "@/server"
import type { LoadMoreState, SessionList, SessionListState, SessionStatusView } from "@/session"
import type { RequestsInternal } from "../requests"
import { hasMorePages, initialListState, type ListEvent, type ListState, type MorePhase } from "./model"
import { createKeyedReads } from "./keyed-reads"
import { createListReads, type ListReads } from "./reads"
import { listTransition } from "./transition"
import { createRowViewCache, rowViews, UNKNOWN_STATUS, visibleOrder } from "./visible-rows"

export type SessionListInternal = SessionList & {
  readonly start: () => void
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

function moreState(phase: MorePhase | undefined): LoadMoreState {
  if (phase?.kind === "loading") return MORE_LOADING
  return phase?.kind === "failed" ? { kind: "failed", error: phase.error } : MORE_IDLE
}

const unknownPlacement = (placementId: PlacementId): AppError => ({
  class: "not_found",
  message: `unknown placement ${placementId}`,
  retryable: false,
})

function pendingRow(ref: SessionRef, input: SessionCreateInput, at: number): SessionRow {
  return {
    ref,
    title: input.title ?? "",
    createdAt: at,
    updatedAt: at,
    ...(input.prompt ? { lastHumanTurnAt: at } : {}),
    ...(input.harness ? { harness: harnessSelectionOf(input.harness) } : {}),
    ...(input.model ? { model: input.model } : {}),
  }
}

async function createPendingSession(server: Server, list: Machine<ListState, ListEvent>, input: SessionCreateInput): Promise<SessionRef> {
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

function routeServerEvent(list: Machine<ListState, ListEvent>, reads: ListReads, event: ServerEvent): void {
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

function createRowReads(state: Accessor<ListState>, requests: RequestsInternal, windows: Accessor<ListState["windows"]>) {
  const cache = createRowViewCache()
  const entries = createMemo(() => state().entries)
  const statuses = createMemo(() => state().statuses)
  const order = createMemo(() => visibleOrder({ entries: entries(), windows: windows() }))
  const views = createMemo(() => rowViews({ order: order(), data: { entries: entries(), statuses: statuses() }, openRequests: requests.openBySession(), cache }))
  const entryOf = createKeyedReads(entries)
  const statusOf = createKeyedReads(statuses)
  return {
    order,
    view: createKeyedReads(views),
    rowOf: (sessionId: SessionId) => {
      const entry = entryOf(sessionId)
      return entry && entry.kind !== "tombstone" ? entry.row : undefined
    },
    statusOf: (sessionId: SessionId) => statusOf(sessionId)?.status ?? UNKNOWN_STATUS,
  }
}

export function createSessionList(server: Server, requests: RequestsInternal): SessionListInternal {
  const list = machine(initialListState, listTransition)
  const reads = createListReads(server, list)
  const { state, send } = list
  const windows = createMemo(() => state().windows)
  const more = createMemo(() => {
    const current = state()
    return current.kind === "live" ? current.more : undefined
  })
  const failures = createMemo(() => state().failures)
  const degraded = createMemo(() => state().degraded)
  return {
    ...createRowReads(state, requests, windows),
    state: createMemo(() => publicState(state())),
    hasMore: (projectId: ProjectId) => hasMorePages(windows(), projectId),
    moreState: (projectId: ProjectId) => moreState(more()?.get(projectId)),
    pageFailure: (projectId: ProjectId) => failures().get(projectId),
    pageDegraded: (projectId: ProjectId) => degraded().has(projectId),
    loadMore: reads.loadMore,
    reload: () => reads.reread("replace"),
    create: (input) => createPendingSession(server, list, input),
    start: () => void reads.fetchFirst(),
    apply: (event) => routeServerEvent(list, reads, event),
    readRow: (row) => send({ type: "rowRead", row }),
    readStatus: (ref, status, sentAt) => send({ type: "statusRead", ref, status, sentAt }),
    opened: (sessionId) => send({ type: "sessionOpened", sessionId }),
    closed: (sessionId) => send({ type: "sessionClosed", sessionId }),
    sendStarted: (sessionId, clientRequestId, at) => send({ type: "sendStarted", sessionId, clientRequestId, at }),
    sendFailed: (sessionId, clientRequestId) => send({ type: "sendFailed", sessionId, clientRequestId }),
  }
}
