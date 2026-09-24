import { responseError } from "./errors"
import { sessionPath, type SessionContext } from "./session-context"
import { withQuery } from "./transport"
import type { SessionRef, TranscriptPage } from "./types"
import { transcriptPageFromWire } from "./wire/transcript"

function coverageMessages(body: unknown): unknown {
  return body && typeof body === "object" && "messages" in body ? body.messages : undefined
}

export async function readTurn(context: SessionContext, ref: SessionRef, turnId: string): Promise<TranscriptPage> {
  const where = await context.workspaces.route(ref)
  const response = await context.transport.runtime(where, withQuery(sessionPath(ref, "/message"), { turn: turnId, coverage: "1" }))
  if (!response.ok) throw await responseError(response, "Turn")
  return transcriptPageFromWire(coverageMessages(await response.json()), null)
}
