import { readField, readString } from "@claxedo/helpers/readers"
import { ServerError } from "./errors"
import type { SessionContext } from "./session-context"
import { withQuery } from "./transport"
import type { SessionOutline, SessionRef, SessionRow, TranscriptPage } from "./types"
import { outlineFromWire } from "./wire/outline"
import { sessionRowFromCentral } from "./wire/session-row"
import { transcriptPageFromWire } from "./wire/transcript"

const CENTRAL_PAGE_SIZE = 50
const SESSIONS = "/api/control/sessions"

export type CentralPage =
  | { readonly view: "latest-surface" }
  | { readonly view: "latest-turn"; readonly before?: string }
  | { readonly before: string }

async function storedMessages(context: SessionContext, ref: SessionRef, query: Readonly<Record<string, string>>): Promise<unknown> {
  if (context.account) return context.account.run("session.messages", { sessionId: ref.sessionId, ...query })
  return context.transport.json(withQuery(`${SESSIONS}/${encodeURIComponent(ref.sessionId)}/messages`, query))
}

async function storedInventory(context: SessionContext, workspaceId: string): Promise<unknown> {
  if (context.account) return context.account.run("session.list", { workspaceId })
  return context.transport.json(withQuery(SESSIONS, { workspaceId }))
}

export async function readCentralPage(context: SessionContext, workspaceId: string, ref: SessionRef, page: CentralPage): Promise<TranscriptPage> {
  const window: Record<string, string> = !("view" in page)
    ? { limit: String(CENTRAL_PAGE_SIZE), before: page.before }
    : page.view === "latest-turn" && page.before !== undefined
      ? { view: page.view, before: page.before }
      : { view: page.view }
  const body = await storedMessages(context, ref, { workspaceId, ...window })
  return transcriptPageFromWire(readField(body, "messages"), readString(body, "nextCursor") ?? null)
}

export async function readCentralOutline(context: SessionContext, workspaceId: string, ref: SessionRef): Promise<SessionOutline | undefined> {
  const body = context.account
    ? await context.account.run("session.outline", { sessionId: ref.sessionId, workspaceId })
    : await context.transport.json(withQuery(`${SESSIONS}/${encodeURIComponent(ref.sessionId)}/outline`, { workspaceId }))
  return outlineFromWire(body)
}

export async function readCentralRow(context: SessionContext, workspaceId: string, ref: SessionRef): Promise<SessionRow> {
  const sessions = readField(await storedInventory(context, workspaceId), "sessions")
  const rows = Array.isArray(sessions) ? sessions : []
  const row = rows.map((item) => sessionRowFromCentral(item, ref)).find((candidate) => candidate !== undefined)
  if (!row) throw new ServerError({ class: "not_found", message: `Session ${ref.sessionId} is not stored for workspace ${workspaceId}` })
  return row
}
