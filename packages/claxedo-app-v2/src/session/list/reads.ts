import { machine, type Machine } from "@/lib/machine"
import type { AppError, PlacementId, Server, SessionRow, SessionStatusRead } from "@/server"
import { toAppError, type RequestsInternal } from "../requests"
import { unreadPlacementsOf } from "./statuses"
import {
  NO_FOLLOW_UP,
  followUpTransition,
  type FetchedPage,
  type FetchedWindow,
  type FollowUp,
  type FollowUpEvent,
  type ListEvent,
  type ListState,
  type RereadMode,
  listedRows,
} from "./model"

const PAGE_SIZE = 5

export type ListReads = {
  readonly fetchFirst: () => Promise<void>
  readonly loadMore: (placementIds: readonly PlacementId[]) => Promise<void>
  readonly reread: (mode: RereadMode) => Promise<void>
  readonly requestReread: (mode: RereadMode) => void
}

type ReadContext = {
  readonly server: Server
  readonly requests: RequestsInternal
  readonly list: Machine<ListState, ListEvent>
  readonly followUp: Machine<FollowUp, FollowUpEvent>
}

function readRequests(requests: RequestsInternal, fetched: readonly SessionRow[], read: SessionStatusRead, sentAt: number): void {
  const reported = new Set(read.reports.map((report) => report.ref.sessionId))
  const unreadPlacements = unreadPlacementsOf(read)
  requests.applyReads(read.reports, sentAt)
  for (const row of fetched) {
    if (!reported.has(row.ref.sessionId) && !unreadPlacements.has(row.ref.placementId)) requests.read(row.ref, [], sentAt)
  }
}

type PageTarget = { readonly placementId: PlacementId; readonly cursor?: string }

async function readPage(context: ReadContext, target: PageTarget): Promise<FetchedPage> {
  const page = await context.server.sessions.list({ placementId: target.placementId, cursor: target.cursor, limit: PAGE_SIZE })
  return { placementId: target.placementId, rows: page.rows, nextCursor: page.nextCursor }
}

async function firstPageTargets(context: ReadContext): Promise<PageTarget[]> {
  return (await context.server.placements.load()).filter((placement) => placement.reachable).map((placement) => ({ placementId: placement.id }))
}

async function readWindow(context: ReadContext, targets: readonly PageTarget[], withStatuses: boolean): Promise<FetchedWindow> {
  const sentAt = Date.now()
  const [pages, statuses] = await Promise.all([
    Promise.all(targets.map((target) => readPage(context, target))),
    withStatuses ? context.server.sessions.statuses() : undefined,
  ])
  if (statuses) readRequests(context.requests, pages.flatMap((page) => page.rows), statuses, sentAt)
  return { pages, sentAt, statuses }
}

function isReading(state: ListState): boolean {
  return state.kind === "fetching" || state.kind === "rereading" || (state.kind === "live" && state.more.kind === "loading")
}

function afterRead(context: ReadContext): void {
  const waiting = context.followUp.state()
  if (waiting.kind === "none") return
  context.followUp.send({ type: "taken" })
  void reread(context, waiting.mode)
}

type StatusesResult = { readonly kind: "read"; readonly read: SessionStatusRead } | { readonly kind: "failed"; readonly error: AppError }

type PendingStatuses = { readonly result: Promise<StatusesResult>; readonly sentAt: number }

function landStatuses(context: ReadContext, result: StatusesResult, sentAt: number): void {
  if (result.kind === "failed") return console.warn("The sessions' statuses could not be read", result.error)
  const rows = listedRows(context.list.state())
  readRequests(context.requests, rows, result.read, sentAt)
  context.list.send({ type: "statusesFetched", read: result.read, sentAt, rows })
}

async function fetchFirstRows(context: ReadContext): Promise<PendingStatuses | undefined> {
  const { send } = context.list
  send({ type: "fetchStarted" })
  try {
    const targets = await firstPageTargets(context)
    const sentAt = Date.now()
    const result = context.server.sessions.statuses().then(
      (read): StatusesResult => ({ kind: "read", read }),
      (cause): StatusesResult => ({ kind: "failed", error: toAppError(cause) }),
    )
    const pages = await Promise.all(targets.map((target) => readPage(context, target)))
    send({ type: "fetched", window: { pages, sentAt, statuses: undefined } })
    return { result, sentAt }
  } catch (cause) {
    send({ type: "fetchFailed", error: toAppError(cause) })
    return undefined
  }
}

async function fetchFirst(context: ReadContext): Promise<void> {
  const statuses = await fetchFirstRows(context)
  afterRead(context)
  if (statuses) landStatuses(context, await statuses.result, statuses.sentAt)
}

function nextPageTargets(state: ListState, placementIds: readonly PlacementId[]): PageTarget[] {
  return placementIds.flatMap((placementId) => {
    const cursor = state.windows.get(placementId)?.nextCursor
    return cursor === undefined ? [] : [{ placementId, cursor }]
  })
}

async function loadMore(context: ReadContext, placementIds: readonly PlacementId[]): Promise<void> {
  const { state, send } = context.list
  const current = state()
  const targets = nextPageTargets(current, placementIds)
  if (current.kind !== "live" || current.more.kind === "loading" || targets.length === 0) return
  send({ type: "moreStarted", placementIds })
  try {
    send({ type: "moreFetched", window: await readWindow(context, targets, false) })
  } catch (cause) {
    send({ type: "moreFailed", error: toAppError(cause) })
  }
  afterRead(context)
}

async function reread(context: ReadContext, mode: RereadMode): Promise<void> {
  const { state, send } = context.list
  const kind = state().kind
  if (kind !== "live" && kind !== "failed") return
  send({ type: "rereadStarted" })
  try {
    send({ type: "rereadFetched", window: await readWindow(context, await firstPageTargets(context), mode === "replace"), mode })
  } catch (cause) {
    send({ type: "rereadFailed", error: toAppError(cause) })
  }
  afterRead(context)
}

function requestReread(context: ReadContext, mode: RereadMode): void {
  if (!isReading(context.list.state())) return void reread(context, mode)
  context.followUp.send({ type: "requested", mode })
}

export function createListReads(server: Server, requests: RequestsInternal, list: Machine<ListState, ListEvent>): ListReads {
  const context: ReadContext = { server, requests, list, followUp: machine(NO_FOLLOW_UP, followUpTransition) }
  return {
    fetchFirst: () => fetchFirst(context),
    loadMore: (placementIds) => loadMore(context, placementIds),
    reread: (mode) => reread(context, mode),
    requestReread: (mode) => requestReread(context, mode),
  }
}
