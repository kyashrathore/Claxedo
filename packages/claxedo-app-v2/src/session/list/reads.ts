import { createSignal, type Accessor, type Setter } from "solid-js"
import type { Machine } from "@/lib/machine"
import type { Server, SessionRow, SessionStatusRead } from "@/server"
import { toAppError, type RequestsInternal } from "../requests"
import type { FetchedWindow, ListEvent, ListState, RereadMode } from "./model"

const PAGE_SIZE = 50

export type ListReads = {
  readonly fetchFirst: () => Promise<void>
  readonly loadMore: () => Promise<void>
  readonly reread: (mode: RereadMode) => Promise<void>
  readonly requestReread: (mode: RereadMode) => void
}

type ReadContext = {
  readonly server: Server
  readonly requests: RequestsInternal
  readonly list: Machine<ListState, ListEvent>
  readonly followUp: Accessor<RereadMode | undefined>
  readonly setFollowUp: Setter<RereadMode | undefined>
}

function readRequests(requests: RequestsInternal, fetched: readonly SessionRow[], read: SessionStatusRead, sentAt: number): void {
  const reported = new Set(read.reports.map((report) => report.ref.sessionId))
  requests.applyReads(read.reports, sentAt)
  for (const row of fetched) if (!reported.has(row.ref.sessionId)) requests.read(row.ref, [], sentAt)
}

async function readWindow(context: ReadContext, cursor: string | undefined, withStatuses: boolean): Promise<FetchedWindow> {
  const sentAt = Date.now()
  const [page, statuses] = await Promise.all([
    context.server.sessions.list({ cursor, limit: PAGE_SIZE }),
    withStatuses ? context.server.sessions.statuses() : undefined,
  ])
  if (statuses) readRequests(context.requests, page.rows, statuses, sentAt)
  return { rows: page.rows, nextCursor: page.nextCursor, sentAt, statuses }
}

function isReading(state: ListState): boolean {
  return state.kind === "fetching" || state.kind === "rereading" || (state.kind === "live" && state.more.kind === "loading")
}

function afterRead(context: ReadContext): void {
  const mode = context.followUp()
  if (!mode) return
  context.setFollowUp(undefined)
  void reread(context, mode)
}

async function fetchFirst(context: ReadContext): Promise<void> {
  const { send } = context.list
  send({ type: "fetchStarted" })
  try {
    send({ type: "fetched", window: await readWindow(context, undefined, true) })
  } catch (cause) {
    send({ type: "fetchFailed", error: toAppError(cause) })
  }
  afterRead(context)
}

async function loadMore(context: ReadContext): Promise<void> {
  const { state, send } = context.list
  const current = state()
  if (current.kind !== "live" || current.more.kind === "loading" || current.nextCursor === undefined) return
  send({ type: "moreStarted" })
  try {
    send({ type: "moreFetched", window: await readWindow(context, current.nextCursor, false) })
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
    send({ type: "rereadFetched", window: await readWindow(context, undefined, true), mode })
  } catch (cause) {
    send({ type: "rereadFailed", error: toAppError(cause) })
  }
  afterRead(context)
}

function requestReread(context: ReadContext, mode: RereadMode): void {
  if (!isReading(context.list.state())) return void reread(context, mode)
  context.setFollowUp((pending) => (pending === "replace" ? pending : mode))
}

export function createListReads(server: Server, requests: RequestsInternal, list: Machine<ListState, ListEvent>): ListReads {
  const [followUp, setFollowUp] = createSignal<RereadMode>()
  const context: ReadContext = { server, requests, list, followUp, setFollowUp }
  return {
    fetchFirst: () => fetchFirst(context),
    loadMore: () => loadMore(context),
    reread: (mode) => reread(context, mode),
    requestReread: (mode) => requestReread(context, mode),
  }
}
