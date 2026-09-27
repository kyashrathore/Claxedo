import { readCentralPage } from "./central-session"
import { responseError } from "./errors"
import { onRuntime, sessionEndpoint, type SessionContext } from "./session-context"
import { withQuery } from "./transport"
import type { SessionRef, TranscriptPage } from "./types"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

export function readWholeTurn(context: SessionContext, ref: SessionRef, before?: string): Promise<TranscriptPage> {
  const window = { view: "latest-turn", before } as const
  return onRuntime(
    context,
    ref,
    async (where) => {
      const response = await context.transport.runtime(where, withQuery(sessionEndpoint(ref, "/message"), window))
      if (!response.ok) throw await responseError(response, "Whole turn")
      return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
    },
    (workspaceId) => readCentralPage(context, workspaceId, ref, window),
  )
}
