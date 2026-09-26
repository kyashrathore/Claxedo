import { responseError, ServerError } from "./errors"
import { withQuery, type Transport } from "./transport"
import type { SessionRef, SessionRow, TranscriptPage } from "./types"
import { sessionRowFromCentral } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

export const CENTRAL_PAGE_SIZE = 50

export type CentralPage = { readonly view: "latest-surface" | "latest-turn" } | { readonly before: string }

export async function readCentralPage(transport: Transport, workspaceId: string, ref: SessionRef, page: CentralPage): Promise<TranscriptPage> {
  const window = "view" in page ? { view: page.view } : { limit: CENTRAL_PAGE_SIZE, before: page.before }
  const path = withQuery(`/api/control/sessions/${encodeURIComponent(ref.sessionId)}/messages`, { workspaceId, ...window })
  const response = await transport.request(path)
  if (!response.ok) throw await responseError(response, "Stored transcript")
  const body = (await response.json()) as { messages?: unknown }
  return transcriptPageFromWire(body.messages, response.headers.get(OLDER_CURSOR_HEADER))
}

export async function readCentralRow(transport: Transport, workspaceId: string, ref: SessionRef): Promise<SessionRow> {
  const body = await transport.json<{ sessions?: unknown }>(withQuery("/api/control/sessions", { workspaceId }))
  const rows = Array.isArray(body.sessions) ? body.sessions : []
  const row = rows.map((item) => sessionRowFromCentral(item, ref)).find((candidate) => candidate !== undefined)
  if (!row) throw new ServerError({ class: "not_found", message: `Session ${ref.sessionId} is not stored for workspace ${workspaceId}` })
  return row
}
