import { readField } from "@claxedo/helpers/readers"
import type { HostedOperationName } from "@claxedo/account-contract"
import { ServerError } from "./errors"
import type { SessionContext } from "./session-context"
import { withQuery } from "./transport"
import type { PageShape, SessionFirstRead, SessionRef, SessionRow, TranscriptPage, TranscriptPart } from "./types"
import { firstReadFromWire, NO_FIRST_PAGE } from "./wire/first-read"
import { sessionRowFromCentral } from "./wire/session-row"
import { partFromWire, turnPageFromWire, viewportQuery } from "./wire/turn-page"

const SESSIONS = "/api/control/sessions"

async function storedRead(context: SessionContext, ref: SessionRef, operation: HostedOperationName, path: string, query: Readonly<Record<string, string>>): Promise<unknown> {
  if (context.account && context.transport.serverKind() === "daemon") return context.account.run(operation, { sessionId: ref.sessionId, ...query })
  return context.transport.json(withQuery(`${SESSIONS}/${encodeURIComponent(ref.sessionId)}/${path}`, query))
}

async function storedInventory(context: SessionContext, workspaceId: string): Promise<unknown> {
  if (context.account && context.transport.serverKind() === "daemon") return context.account.run("session.list", { workspaceId })
  return context.transport.json(withQuery(SESSIONS, { workspaceId }))
}

function storedRow(item: unknown, ref: SessionRef, workspaceId: string): SessionRow {
  const row = sessionRowFromCentral(item, ref)
  if (!row) throw new ServerError({ class: "not_found", message: `Session ${ref.sessionId} is not stored for workspace ${workspaceId}` })
  return row
}

export async function readCentralTurnPage(context: SessionContext, workspaceId: string, ref: SessionRef, shape: PageShape, before: string): Promise<TranscriptPage> {
  return turnPageFromWire(await storedRead(context, ref, "session.turnPage", "page", { workspaceId, before, ...viewportQuery(shape) }))
}

export async function readCentralPart(context: SessionContext, workspaceId: string, ref: SessionRef, messageId: string, partId: string): Promise<TranscriptPart> {
  return partFromWire(readField(await storedRead(context, ref, "session.part", "part", { workspaceId, messageId, partId }), "part"))
}

export async function readCentralFirst(context: SessionContext, workspaceId: string, ref: SessionRef, shape: PageShape): Promise<SessionFirstRead> {
  const read = firstReadFromWire(await storedRead(context, ref, "session.outline", "outline", { workspaceId, ...viewportQuery(shape) }))
  return { row: storedRow(read.session, ref, workspaceId), diff: [], outline: read.outline, ...(read.page ?? NO_FIRST_PAGE) }
}

export async function readCentralRow(context: SessionContext, workspaceId: string, ref: SessionRef): Promise<SessionRow> {
  const sessions = readField(await storedInventory(context, workspaceId), "sessions")
  const rows = Array.isArray(sessions) ? sessions : []
  const listed = rows.find((item) => sessionRowFromCentral(item, ref) !== undefined)
  return storedRow(listed, ref, workspaceId)
}
