import { createSignal } from "solid-js"

/**
 * A request to re-read session history and todo through the session
 * controllers that have the sessions mounted.
 *
 * Raised when a workspace stream reports a hole (its `stream.replay-gap`
 * frame) or opens without a cursor. In both cases what a session did is
 * behind the stream rather than on it — the frames the reader never received,
 * or everything between a pane's history read and the open — and the stream
 * is live from here on, so the store's view of a turn — part status, streamed
 * text, todo — is only repaired by reading it. The request names the
 * workspace the stream serves and no session: every controller mounted for
 * that workspace answers for its own session. The reads belong to the
 * controller (`syncSessionHistory`, `syncSessionTodo`); a request no
 * controller matches is dropped, because a later mount loads history on
 * activation anyway.
 */
export type SessionHistoryResync = {
  sequence: number
  directory?: string
  sessionID?: string
  /** A stream reported a hole, or a workspace stream opened without a cursor. */
  reason: "sse-gap" | "stream-open"
}

let sequence = 0
const [resync, setResync] = createSignal<SessionHistoryResync>()

export function requestSessionHistoryResync(input: Omit<SessionHistoryResync, "sequence">) {
  sequence += 1
  setResync({ ...input, sequence })
}

export function sessionHistoryResyncRequest() {
  return resync()
}

export function sessionHistoryResyncMatches(input: {
  request?: Pick<SessionHistoryResync, "sessionID" | "directory">
  sessionID?: string
  directory: string
}) {
  if (!input.request || !input.sessionID) return false
  if (input.request.sessionID !== undefined && input.request.sessionID !== input.sessionID) return false
  if (input.request.directory !== undefined && input.request.directory !== input.directory) return false
  return true
}

export function resetSessionHistoryResyncForTest() {
  setResync(undefined)
}
