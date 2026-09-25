import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { responseError } from "./errors"
import { sessionEndpoint, type SessionContext } from "./session-context"
import { readGoalState } from "./session-goal"
import { readRequests } from "./session-statuses"
import { withQuery, type RuntimeRoute } from "./transport"
import type { SessionListInput, SessionPage, SessionReads, SessionRef, SessionRow, Todo, TranscriptPage } from "./types"
import { sessionRowFromListItem, sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const WORKSPACE_SCOPE = "workspace"

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
  const where = await context.workspaces.route(options.placementId)
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  const target = transport.loopback && !where.remote ? { directory: where.directory } : { workspaceId: where.workspaceId }
  const query = { scope: WORKSPACE_SCOPE, ...target, sort: "human_turn_desc", limit: options.limit, cursor: options.cursor }
  const body = await transport.json<{ items?: unknown; nextCursor?: unknown }>(withQuery(listPath, query))
  const rows = await rowsOf(context, Array.isArray(body.items) ? body.items : [])
  return { rows, ...(typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}) }
}

async function readPage(context: SessionContext, where: RuntimeRoute, path: string): Promise<TranscriptPage> {
  const response = await context.transport.runtime(where, path)
  if (!response.ok) throw await responseError(response, "Transcript page")
  return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
}

export function readSession(context: SessionContext, ref: SessionRef): SessionReads {
  const { transport } = context
  const where = context.workspaces.route(ref)
  const transcript = where.then((route) => readPage(context, route, withQuery(sessionEndpoint(ref, "/message"), { view: "latest-surface" })))
  const row = where.then((route) => transport.runtimeJson<AgentPresentationSession>(route, sessionEndpoint(ref)))
  const requests = where.then(async (route) => (await readRequests(transport, route, ref.sessionId)).map((item) => item.request))
  const todos = where.then((route) => transport.runtimeJson<readonly Todo[]>(route, sessionEndpoint(ref, "/todo")))
  const goal = where.then((route) => readGoalState(transport, route, ref))
  return {
    surface: Promise.all([row, transcript]).then(([session, page]) => ({ row: sessionRowFromSession(session, ref), transcript: page, diff: session.summary?.diffs ?? [] })),
    status: Promise.all([where, row]).then(([route, session]) => context.status.read(route, ref, session)),
    requests,
    todos,
    goal,
  }
}

export async function readOlder(context: SessionContext, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  const where = await context.workspaces.route(ref)
  return readPage(context, where, withQuery(sessionEndpoint(ref, "/message"), { limit: OLDER_PAGE_SIZE, before: cursor }))
}
