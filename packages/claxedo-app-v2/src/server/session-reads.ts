import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { responseError } from "./errors"
import { sessionPath, type SessionContext } from "./session-context"
import { readGoalState } from "./session-goal"
import { readRequests } from "./session-statuses"
import { withQuery, type RuntimeRoute } from "./transport"
import type { SessionPage, SessionRef, SessionRow, SessionSnapshot, TranscriptPage } from "./types"
import { sessionRowFromListItem, sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const ALL_WORKSPACES_SCOPE = "workspace"

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

export async function listSessions(context: SessionContext, options: { readonly cursor?: string; readonly limit: number }): Promise<SessionPage> {
  const { transport } = context
  await context.workspaces.load()
  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"
  const query = { scope: ALL_WORKSPACES_SCOPE, sort: "human_turn_desc", limit: options.limit, cursor: options.cursor }
  const body = await transport.json<{ items?: unknown; nextCursor?: unknown }>(withQuery(listPath, query))
  const rows = await rowsOf(context, Array.isArray(body.items) ? body.items : [])
  return { rows, ...(typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}) }
}

async function readPage(context: SessionContext, where: RuntimeRoute, path: string): Promise<TranscriptPage> {
  const response = await context.transport.runtime(where, path)
  if (!response.ok) throw await responseError(response, "Transcript page")
  return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
}

export async function readSnapshot(context: SessionContext, ref: SessionRef): Promise<SessionSnapshot> {
  const { transport } = context
  const where = await context.workspaces.route(ref)
  const [row, transcript, requests, todos, goal] = await Promise.all([
    transport.runtimeJson<AgentPresentationSession>(where, sessionPath(ref)),
    readPage(context, where, withQuery(sessionPath(ref, "/message"), { view: "latest-surface" })),
    readRequests(transport, where, ref.sessionId),
    transport.runtimeJson<SessionSnapshot["todos"]>(where, sessionPath(ref, "/todo")),
    readGoalState(transport, where, ref),
  ])
  return {
    row: sessionRowFromSession(row, ref),
    status: await context.status.read(where, ref.sessionId, row),
    transcript,
    requests: requests.map((item) => item.request),
    todos,
    diff: row.summary?.diffs ?? [],
    goal,
  }
}

export async function readOlder(context: SessionContext, ref: SessionRef, cursor: string): Promise<TranscriptPage> {
  const where = await context.workspaces.route(ref)
  return readPage(context, where, withQuery(sessionPath(ref, "/message"), { limit: OLDER_PAGE_SIZE, before: cursor }))
}
