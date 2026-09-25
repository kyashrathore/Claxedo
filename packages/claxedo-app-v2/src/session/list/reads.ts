import { machine, type Machine } from "@/lib/machine"
import type { ProjectId, Server } from "@/server"
import { toAppError } from "../requests"
import {
  NO_FOLLOW_UP,
  followUpTransition,
  type FailedPage,
  type FetchedPage,
  type FetchedWindow,
  type FollowUp,
  type FollowUpEvent,
  type ListEvent,
  type ListState,
  type RereadMode,
} from "./model"

const PAGE_SIZE = 5

export type ListReads = {
  readonly fetchFirst: () => Promise<void>
  readonly loadMore: (projectId: ProjectId) => Promise<void>
  readonly reread: (mode: RereadMode) => Promise<void>
  readonly requestReread: (mode: RereadMode) => void
}

type ReadContext = {
  readonly server: Server
  readonly list: Machine<ListState, ListEvent>
  readonly followUp: Machine<FollowUp, FollowUpEvent>
}

type PageTarget = { readonly projectId: ProjectId; readonly cursor?: string }

async function readPage(context: ReadContext, target: PageTarget): Promise<FetchedPage> {
  const page = await context.server.sessions.list({ projectId: target.projectId, cursor: target.cursor, limit: PAGE_SIZE })
  return { projectId: target.projectId, rows: page.rows, statuses: page.statuses, nextCursor: page.nextCursor }
}

async function firstPageTargets(context: ReadContext): Promise<PageTarget[]> {
  const projectIds = new Set((await context.server.placements.load()).map((placement) => placement.projectId))
  return [...projectIds].map((projectId) => ({ projectId }))
}

async function readWindow(context: ReadContext, targets: readonly PageTarget[]): Promise<FetchedWindow> {
  const sentAt = Date.now()
  const read = await Promise.all(targets.map((target) =>
    readPage(context, target).then(
      (page): FetchedPage | FailedPage => page,
      (cause): FetchedPage | FailedPage => ({ projectId: target.projectId, error: toAppError(cause) }),
    )))
  const pages = read.filter((item): item is FetchedPage => "rows" in item)
  const failures = read.filter((item): item is FailedPage => "error" in item)
  return { pages, failures, sentAt }
}

function isReading(state: ListState): boolean {
  if (state.kind === "fetching" || state.kind === "rereading") return true
  return state.kind === "live" && [...state.more.values()].some((phase) => phase.kind === "loading")
}

function afterRead(context: ReadContext): void {
  if (isReading(context.list.state())) return
  const waiting = context.followUp.state()
  if (waiting.kind === "none") return
  context.followUp.send({ type: "taken" })
  void reread(context, waiting.mode)
}

async function fetchFirst(context: ReadContext): Promise<void> {
  const { send } = context.list
  send({ type: "fetchStarted" })
  try {
    send({ type: "fetched", window: await readWindow(context, await firstPageTargets(context)) })
  } catch (cause) {
    send({ type: "fetchFailed", error: toAppError(cause) })
  }
  afterRead(context)
}

async function loadMore(context: ReadContext, projectId: ProjectId): Promise<void> {
  const { state, send } = context.list
  const current = state()
  const cursor = current.windows.get(projectId)?.nextCursor
  if (current.kind !== "live" || current.more.get(projectId)?.kind === "loading" || cursor === undefined) return
  send({ type: "moreStarted", projectId })
  try {
    send({ type: "moreFetched", projectId, window: await readWindow(context, [{ projectId, cursor }]) })
  } catch (cause) {
    send({ type: "moreFailed", projectId, error: toAppError(cause) })
  }
  afterRead(context)
}

async function reread(context: ReadContext, mode: RereadMode): Promise<void> {
  const { state, send } = context.list
  const kind = state().kind
  if (kind !== "live" && kind !== "failed") return
  send({ type: "rereadStarted" })
  try {
    send({ type: "rereadFetched", window: await readWindow(context, await firstPageTargets(context)), mode })
  } catch (cause) {
    send({ type: "rereadFailed", error: toAppError(cause) })
  }
  afterRead(context)
}

function requestReread(context: ReadContext, mode: RereadMode): void {
  if (!isReading(context.list.state())) return void reread(context, mode)
  context.followUp.send({ type: "requested", mode })
}

export function createListReads(server: Server, list: Machine<ListState, ListEvent>): ListReads {
  const context: ReadContext = { server, list, followUp: machine(NO_FOLLOW_UP, followUpTransition) }
  return {
    fetchFirst: () => fetchFirst(context),
    loadMore: (projectId) => loadMore(context, projectId),
    reread: (mode) => reread(context, mode),
    requestReread: (mode) => requestReread(context, mode),
  }
}
