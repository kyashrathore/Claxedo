import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { readCentralPage, readCentralRow } from "./central-session"
import { responseError } from "./errors"
import { sessionEndpoint, type SessionContext } from "./session-context"
import { NO_GOAL, readGoalState } from "./session-goal"
import { readRequests } from "./session-requests"
import { withQuery, type RuntimeRoute } from "./transport"
import type { ListedStatus, SessionListInput, SessionPage, SessionReads, SessionRef, SessionRow, SessionStatus, SessionSurface, Todo, TranscriptPage } from "./types"
import type { SessionId } from "./ids"
import type { SessionHome } from "./workspaces"
import { isWorkspaceStopped } from "./wire/connection"
import { listedStatusFromListItem, sessionRowFromListItem, sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const STOPPED_STATUS: SessionStatus = { kind: "idle" }

async function listedOf(context: SessionContext, items: readonly unknown[]) {
  const { address } = context.workspaces
  const rows: SessionRow[] = []
  const statuses = new Map<SessionId, ListedStatus>()
  for (const item of items) {
    let row = sessionRowFromListItem(item, address)
    const directory = (item as { directory?: unknown }).directory
    if (!row && typeof directory === "string") {
      await context.workspaces.learn(directory)
      row = sessionRowFromListItem(item, address)
    }
    if (!row) continue
    rows.push(row)
    const listed = listedStatusFromListItem(item)
    if (listed) statuses.set(row.ref.sessionId, { ...listed, status: context.status.listed(row.ref, listed.status) })
  }
  return { rows, statuses }
}

export async function listSessions(context: SessionContext, options: SessionListInput): Promise<SessionPage> {
  const { transport } = context
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  const query = { scope: "project", projectId: options.projectId, sort: "human_turn_desc", limit: options.limit, after: options.after }
  const body = await transport.json<{ items?: unknown; nextAfter?: unknown }>(withQuery(listPath, query))
  const listed = await listedOf(context, Array.isArray(body.items) ? body.items : [])
  return { ...listed, ...(typeof body.nextAfter === "string" ? { nextAfter: body.nextAfter } : {}) }
}

export async function onRuntime<T>(
  context: SessionContext,
  ref: SessionRef,
  live: (route: RuntimeRoute) => Promise<T>,
  stopped: (workspaceId: string) => Promise<T>,
): Promise<T> {
  const home = await context.workspaces.home(ref)
  if (!home.live) return stopped(home.route.workspaceId)
  try {
    return await live(home.route)
  } catch (error) {
    if (!isWorkspaceStopped(error)) throw error
    await context.workspaces.refresh()
    if ((await context.workspaces.home(ref)).live) throw error
    return stopped(home.route.workspaceId)
  }
}

async function readPage(context: SessionContext, where: RuntimeRoute, path: string): Promise<TranscriptPage> {
  const response = await context.transport.runtime(where, path)
  if (!response.ok) throw await responseError(response, "Transcript page")
  return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
}

function readHistory(context: SessionContext, ref: SessionRef, home: SessionHome, before?: string): Promise<TranscriptPage> {
  if (home.central) return readCentralPage(context.transport, home.route.workspaceId, ref, before)
  const page = before === undefined ? { view: "latest-surface" } : { limit: OLDER_PAGE_SIZE, before }
  return readPage(context, home.route, withQuery(sessionEndpoint(ref, "/message"), page))
}

async function readSurface(context: SessionContext, ref: SessionRef, home: SessionHome, session: AgentPresentationSession | undefined): Promise<SessionSurface> {
  const [transcript, row] = await Promise.all([
    readHistory(context, ref, home),
    session ? sessionRowFromSession(session, ref) : readCentralRow(context.transport, home.route.workspaceId, ref),
  ])
  return { row, transcript, diff: session?.summary?.diffs ?? [] }
}

export function readSession(context: SessionContext, ref: SessionRef): SessionReads {
  const { transport } = context
  const live = <T>(read: (route: RuntimeRoute) => Promise<T>, stopped: T) => onRuntime(context, ref, read, async () => stopped)
  const session = live<AgentPresentationSession | undefined>((route) => transport.runtimeJson<AgentPresentationSession>(route, sessionEndpoint(ref)), undefined)
  return {
    surface: Promise.all([context.workspaces.home(ref), session]).then(([home, row]) => readSurface(context, ref, home, row)),
    status: live(async (route) => {
      const row = await session
      return row ? context.status.read(route, ref, row) : STOPPED_STATUS
    }, STOPPED_STATUS),
    requests: live(async (route) => (await readRequests(transport, route, ref.sessionId)).map((item) => item.request), []),
    todos: live((route) => transport.runtimeJson<readonly Todo[]>(route, sessionEndpoint(ref, "/todo")), []),
    goal: live((route) => readGoalState(transport, route, ref), NO_GOAL),
  }
}

export async function readOlder(context: SessionContext, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  return readHistory(context, ref, await context.workspaces.home(ref), cursor)
}
