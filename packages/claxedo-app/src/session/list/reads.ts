import { machine, type Machine } from "@/lib/machine"
import { toAppError, type ProjectId, type Server, type SettledFilter } from "@/server"
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
  readonly settled: () => SettledFilter
  readonly list: Machine<ListState, ListEvent>
  readonly followUp: Machine<FollowUp, FollowUpEvent>
}

type PageTarget = { readonly projectId: ProjectId; readonly after?: string }

async function readSessionListPage(context: ReadContext, target: PageTarget): Promise<FetchedPage> {
  const page = await context.server.sessions.list({ projectId: target.projectId, after: target.after, limit: PAGE_SIZE, settled: context.settled() })
  return { projectId: target.projectId, rows: page.rows, statuses: page.statuses, readers: page.readers, nextAfter: page.nextAfter, degraded: page.degraded === true }
}

async function firstPageTargets(context: ReadContext): Promise<PageTarget[]> {
  const projectIds = new Set((await context.server.placements.load()).map((placement) => placement.projectId))
  return [...projectIds].map((projectId) => ({ projectId }))
}

async function readWindow(context: ReadContext, targets: readonly PageTarget[]): Promise<FetchedWindow> {
  const sentAt = Date.now()
  const read = await Promise.all(targets.map((target) =>
    readSessionListPage(context, target).then(
      (page): FetchedPage | FailedPage => page,
      (cause): FetchedPage | FailedPage => ({ projectId: target.projectId, error: toAppError(cause) }),
    )))
  const pages = read.filter((item): item is FetchedPage => "rows" in item)
  const failures = read.filter((item): item is FailedPage => "error" in item)
  return { pages, failures, sentAt }
}

function isListReading(state: ListState): boolean {
  if (state.kind === "fetching" || state.kind === "rereading") return true
  return state.kind === "live" && [...state.more.values()].some((phase) => phase.kind === "loading")
}

function afterRead(context: ReadContext): void {
  if (isListReading(context.list.state())) return
  const waiting = context.followUp.state()
  if (waiting.kind === "none") return
  context.followUp.send({ type: "taken" })
  void rereadList(context, waiting.mode)
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
  const after = current.windows.get(projectId)?.nextAfter
  if (current.kind !== "live" || current.more.get(projectId)?.kind === "loading" || after === undefined) return
  send({ type: "moreStarted", projectId })
  try {
    send({ type: "moreFetched", projectId, window: await readWindow(context, [{ projectId, after }]) })
  } catch (cause) {
    send({ type: "moreFailed", projectId, error: toAppError(cause) })
  }
  afterRead(context)
}

async function rereadList(context: ReadContext, mode: RereadMode): Promise<void> {
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
  if (!isListReading(context.list.state())) return void rereadList(context, mode)
  context.followUp.send({ type: "requested", mode })
}

export function createListReads(server: Server, list: Machine<ListState, ListEvent>, settled: () => SettledFilter): ListReads {
  const context: ReadContext = { server, settled, list, followUp: machine(NO_FOLLOW_UP, followUpTransition) }
  return {
    fetchFirst: () => fetchFirst(context),
    loadMore: (projectId) => loadMore(context, projectId),
    reread: (mode) => rereadList(context, mode),
    requestReread: (mode) => requestReread(context, mode),
  }
}
