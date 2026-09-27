import { readField, readString } from "@claxedo/helpers/readers"
import { ServerError } from "./errors"
import type { SessionContext } from "./session-context"
import { withQuery } from "./transport"
import type { FirstPageShape, SessionFirstRead, SessionRef, SessionRow, TranscriptPage } from "./types"
import { firstReadFromWire, NO_FIRST_PAGE, viewportQuery } from "./wire/first-read"
import { sessionRowFromCentral } from "./wire/session-row"
import { transcriptPageFromWire } from "./wire/transcript"

const CENTRAL_PAGE_SIZE = 50
const SESSIONS = "/api/control/sessions"

export type CentralPage = { readonly view: "latest-turn"; readonly before?: string } | { readonly before: string }

async function storedMessages(context: SessionContext, ref: SessionRef, query: Readonly<Record<string, string>>): Promise<unknown> {
  if (context.account) return context.account.run("session.messages", { sessionId: ref.sessionId, ...query })
  return context.transport.json(withQuery(`${SESSIONS}/${encodeURIComponent(ref.sessionId)}/messages`, query))
}

async function storedInventory(context: SessionContext, workspaceId: string): Promise<unknown> {
  if (context.account) return context.account.run("session.list", { workspaceId })
  return context.transport.json(withQuery(SESSIONS, { workspaceId }))
}

function storedRow(item: unknown, ref: SessionRef, workspaceId: string): SessionRow {
  const row = sessionRowFromCentral(item, ref)
  if (!row) throw new ServerError({ class: "not_found", message: `Session ${ref.sessionId} is not stored for workspace ${workspaceId}` })
  return row
}

export async function readCentralPage(context: SessionContext, workspaceId: string, ref: SessionRef, page: CentralPage): Promise<TranscriptPage> {
  const window: Record<string, string> = !("view" in page)
    ? { limit: String(CENTRAL_PAGE_SIZE), before: page.before }
    : page.before !== undefined
      ? { view: page.view, before: page.before }
      : { view: page.view }
  const body = await storedMessages(context, ref, { workspaceId, ...window })
  return transcriptPageFromWire(readField(body, "messages"), readString(body, "nextCursor") ?? null)
}

export async function readCentralFirst(context: SessionContext, workspaceId: string, ref: SessionRef, shape: FirstPageShape): Promise<SessionFirstRead> {
  const query = { workspaceId, ...viewportQuery(shape) }
  const body = context.account
    ? await context.account.run("session.outline", { sessionId: ref.sessionId, ...query })
    : await context.transport.json(withQuery(`${SESSIONS}/${encodeURIComponent(ref.sessionId)}/outline`, query))
  const read = firstReadFromWire(body)
  return { row: storedRow(read.session, ref, workspaceId), diff: [], outline: read.outline, ...(read.page ?? NO_FIRST_PAGE) }
}

export async function readCentralRow(context: SessionContext, workspaceId: string, ref: SessionRef): Promise<SessionRow> {
  const sessions = readField(await storedInventory(context, workspaceId), "sessions")
  const rows = Array.isArray(sessions) ? sessions : []
  const listed = rows.find((item) => sessionRowFromCentral(item, ref) !== undefined)
  return storedRow(listed, ref, workspaceId)
}
