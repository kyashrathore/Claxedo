import { responseError } from "./errors"
import { sessionPath, type SessionContext } from "./session-context"
import { withQuery } from "./transport"
import type { SessionRef, TranscriptPage } from "./types"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

export async function readLatestTurn(context: SessionContext, ref: SessionRef): Promise<TranscriptPage> {
  const where = await context.workspaces.route(ref)
  const response = await context.transport.runtime(where, withQuery(sessionPath(ref, "/message"), { view: "latest-turn" }))
  if (!response.ok) throw await responseError(response, "Latest turn")
  return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
}
