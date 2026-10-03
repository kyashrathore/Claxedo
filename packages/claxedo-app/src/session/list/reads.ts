import type { SessionLastTurn } from "@claxedo/agent-runtime-contract"
import { machine, type Machine } from "@/lib/machine"
import { toAppError, type Server, type SessionListScope, type SessionLocation, type SettledFilter } from "@/server"
import {
  ACTIVITY_WINDOW,
  NO_FOLLOW_UP,
  canReadPage,
  followUpTransition,
  type FailedPage,
  type FetchedPage,
  type FetchedWindow,
  type FollowUp,
  type FollowUpEvent,
  type ListEvent,
  type ListState,
  type RereadMode,
  type WindowKey,
} from "./model"

const PROJECT_PAGE_SIZE = 5
const ACTIVITY_PAGE_SIZE = 20

export type ListReads = {
  readonly fetchFirst: () => Promise<void>
  readonly loadMore: (windowKey: WindowKey) => Promise<void>
  readonly openActivity: () => Promise<void>
  readonly reread: (mode: RereadMode) => Promise<void>
  readonly requestReread: (mode: RereadMode) => void
  readonly readTurnEndRow: (ref: SessionLocation, lastTurn: SessionLastTurn) => Promise<void>
}

export type ListReadOptions = { readonly settled: () => SettledFilter; readonly activityShown: () => boolean }

type ReadContext = ListReadOptions & {
  readonly server: Server
  readonly list: Machine<ListState, ListEvent>
  readonly followUp: Machine<FollowUp, FollowUpEvent>
}

type PageTarget = { readonly windowKey: WindowKey; readonly after?: string }

const listScopeOf = (windowKey: WindowKey): SessionListScope => (windowKey === ACTIVITY_WINDOW ? { every: true } : { projectId: windowKey })

async function readSessionListPage(context: ReadContext, target: PageTarget): Promise<FetchedPage> {
  const limit = target.windowKey === ACTIVITY_WINDOW ? ACTIVITY_PAGE_SIZE : PROJECT_PAGE_SIZE
  const page = await context.server.sessions.list({ ...listScopeOf(target.windowKey), after: target.after, limit, settled: context.settled() })
  return { windowKey: target.windowKey, rows: page.rows, statuses: page.statuses, readers: page.readers, nextAfter: page.nextAfter, degraded: page.degraded === true }
}

async function firstPageTargets(context: ReadContext): Promise<PageTarget[]> {
  const projectIds = new Set((await context.server.placements.load()).map((placement) => placement.projectId))
  const activity = context.activityShown() || context.list.state().windows.has(ACTIVITY_WINDOW)
  const windowKeys: WindowKey[] = [...projectIds, ...(activity ? [ACTIVITY_WINDOW] : [])]
  return windowKeys.map((windowKey) => ({ windowKey }))
}

async function readWindow(context: ReadContext, targets: readonly PageTarget[]): Promise<FetchedWindow> {
  const sentAt = Date.now()
  const read = await Promise.all(targets.map((target) =>
    readSessionListPage(context, target).then(
      (page): FetchedPage | FailedPage => page,
      (cause): FetchedPage | FailedPage => ({ windowKey: target.windowKey, error: toAppError(cause) }),
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
  const state = context.list.state()
  if (isListReading(state)) return
  const waiting = context.followUp.state()
  if (waiting.kind !== "none") {
    context.followUp.send({ type: "taken" })
    return void rereadList(context, waiting.mode)
  }
  if (context.activityShown()) void openActivity(context)
}

function openActivity(context: ReadContext): Promise<void> {
  return context.list.state().windows.has(ACTIVITY_WINDOW) ? Promise.resolve() : loadMore(context, ACTIVITY_WINDOW)
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

async function loadMore(context: ReadContext, windowKey: WindowKey): Promise<void> {
  const { state, send } = context.list
  const current = state()
  if (current.kind !== "live" || current.more.get(windowKey)?.kind === "loading" || !canReadPage(current.windows, windowKey)) return
  send({ type: "moreStarted", windowKey })
  try {
    send({ type: "moreFetched", windowKey, window: await readWindow(context, [{ windowKey, after: current.windows.get(windowKey)?.nextAfter }]) })
  } catch (cause) {
    send({ type: "moreFailed", windowKey, error: toAppError(cause) })
  }
  afterRead(context)
}

async function readTurnEndRow(context: ReadContext, ref: SessionLocation, lastTurn: SessionLastTurn): Promise<void> {
  const sentAt = Date.now()
  try {
    const page = await context.server.sessions.list({ every: true, sessionId: ref.sessionId, limit: 1, settled: "all" })
    const read: FetchedPage = { windowKey: ref.projectId, rows: page.rows, statuses: page.statuses, readers: page.readers, nextAfter: undefined, degraded: false }
    context.list.send({ type: "turnEndRowRead", window: { pages: [read], failures: [], sentAt }, ref, lastTurn })
  } catch (cause) {
    console.warn("A session's row could not be read for the list", { sessionId: ref.sessionId, error: toAppError(cause) })
  }
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

export function createListReads(server: Server, list: Machine<ListState, ListEvent>, options: ListReadOptions): ListReads {
  const context: ReadContext = { ...options, server, list, followUp: machine(NO_FOLLOW_UP, followUpTransition) }
  return {
    fetchFirst: () => fetchFirst(context),
    loadMore: (windowKey) => loadMore(context, windowKey),
    openActivity: () => openActivity(context),
    reread: (mode) => rereadList(context, mode),
    requestReread: (mode) => requestReread(context, mode),
    readTurnEndRow: (ref, lastTurn) => readTurnEndRow(context, ref, lastTurn),
  }
}
