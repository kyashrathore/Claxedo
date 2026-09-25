import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { readCentralPage, readCentralRow } from "./central-session"
import { responseError } from "./errors"
import { sessionEndpoint, type SessionContext } from "./session-context"
import { NO_GOAL, readGoalState } from "./session-goal"
import { readRequests } from "./session-statuses"
import { withQuery, type RuntimeRoute } from "./transport"
import type { SessionListInput, SessionPage, SessionReads, SessionRef, SessionRow, SessionStatus, SessionSurface, Todo, TranscriptPage } from "./types"
import { isWorkspaceStopped } from "./wire/connection"
import { sessionRowFromListItem, sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const WORKSPACE_SCOPE = "workspace"
const STOPPED_STATUS: SessionStatus = { kind: "idle" }

async function rowsOf(context: SessionContext, items: readonly unknown[]): Promise<SessionRow[]> {
  const { address } = context.workspaces
  const rows: SessionRow[] = []
  for (const item of items) {
    let row = sessionRowFromListItem(item, address)
    const directory = (item as { directory?: unknown }).directory
    if (!row && typeof directory === "string") {
      await context.workspaces.learn(directory)
      row = sessionRowFromListItem(item, address)
    }
    if (row) rows.push(row)
  }
  return rows
}

export async function listSessions(context: SessionContext, options: SessionListInput): Promise<SessionPage> {
  const { transport } = context
  const where = await context.workspaces.locate(options.placementId)
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  const target = transport.loopback && !where.remote ? { directory: where.directory } : { workspaceId: where.workspaceId }
  const query = { scope: WORKSPACE_SCOPE, ...target, sort: "human_turn_desc", limit: options.limit, cursor: options.cursor }
  const body = await transport.json<{ items?: unknown; nextCursor?: unknown }>(withQuery(listPath, query))
  const rows = await rowsOf(context, Array.isArray(body.items) ? body.items : [])
  return { rows, ...(typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}) }
}

export async function homed<T>(
  context: SessionContext,
  ref: SessionRef,
  runtime: (route: RuntimeRoute) => Promise<T>,
  central: (workspaceId: string) => Promise<T>,
): Promise<T> {
  const home = await context.workspaces.home(ref)
  if (home.kind === "central") return central(home.workspaceId)
  try {
    return await runtime(home.route)
  } catch (error) {
    if (!isWorkspaceStopped(error)) throw error
    await context.workspaces.refresh()
    const learned = await context.workspaces.home(ref)
    if (learned.kind === "runtime") throw error
    return central(learned.workspaceId)
  }
}

async function readPage(context: SessionContext, where: RuntimeRoute, path: string): Promise<TranscriptPage> {
  const response = await context.transport.runtime(where, path)
  if (!response.ok) throw await responseError(response, "Transcript page")
  return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
}

type Surfaced = { readonly surface: SessionSurface; readonly session?: AgentPresentationSession }

async function runtimeSurface(context: SessionContext, ref: SessionRef, where: RuntimeRoute): Promise<Surfaced> {
  const [session, transcript] = await Promise.all([
    context.transport.runtimeJson<AgentPresentationSession>(where, sessionEndpoint(ref)),
    readPage(context, where, withQuery(sessionEndpoint(ref, "/message"), { view: "latest-surface" })),
  ])
  return { session, surface: { row: sessionRowFromSession(session, ref), transcript, diff: session.summary?.diffs ?? [] } }
}

async function centralSurface(context: SessionContext, ref: SessionRef, workspaceId: string): Promise<Surfaced> {
  const [row, transcript] = await Promise.all([readCentralRow(context.transport, workspaceId, ref), readCentralPage(context.transport, workspaceId, ref)])
  return { surface: { row, transcript, diff: [] } }
}

export function readSession(context: SessionContext, ref: SessionRef): SessionReads {
  const { transport } = context
  const live = <T>(read: (route: RuntimeRoute) => Promise<T>, stopped: T) => homed(context, ref, read, async () => stopped)
  const surfaced = homed(context, ref, (route) => runtimeSurface(context, ref, route), (workspaceId) => centralSurface(context, ref, workspaceId))
  return {
    surface: surfaced.then(({ surface }) => surface),
    status: live(async (route) => {
      const { session } = await surfaced
      return session ? context.status.read(route, ref, session) : STOPPED_STATUS
    }, STOPPED_STATUS),
    requests: live(async (route) => (await readRequests(transport, route, ref.sessionId)).map((item) => item.request), []),
    todos: live((route) => transport.runtimeJson<readonly Todo[]>(route, sessionEndpoint(ref, "/todo")), []),
    goal: live((route) => readGoalState(transport, route, ref), NO_GOAL),
  }
}

export function readOlder(context: SessionContext, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  return homed(
    context,
    ref,
    (route) => readPage(context, route, withQuery(sessionEndpoint(ref, "/message"), { limit: OLDER_PAGE_SIZE, before: cursor })),
    (workspaceId) => readCentralPage(context.transport, workspaceId, ref, cursor),
  )
}
