import { readCentralPage } from "./central-session"
import { responseError } from "./errors"
import { sessionEndpoint, type SessionContext } from "./session-context"
import { onRuntime } from "./session-reads"
import { withQuery } from "./transport"
import type { SessionRef, TranscriptPage } from "./types"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

export function readLatestTurn(context: SessionContext, ref: SessionRef): Promise<TranscriptPage> {
  return onRuntime(
    context,
    ref,
    async (where) => {
      const response = await context.transport.runtime(where, withQuery(sessionEndpoint(ref, "/message"), { view: "latest-turn" }))
      if (!response.ok) throw await responseError(response, "Latest turn")
      return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
    },
    (workspaceId) => readCentralPage(context, workspaceId, ref, { view: "latest-turn" }),
  )
}
