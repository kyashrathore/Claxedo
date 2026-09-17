import { createSignal } from "solid-js"

/**
 * A request to re-read session history and todo through the session
 * controllers that have the sessions mounted.
 *
 * Raised when a stream reports a hole (its `stream.replay-gap` frame). The
 * frames the client never received are behind the notice and the stream is
 * already live again, so the store's view of a turn — part status, streamed
 * text, todo — is only repaired by reading it. The notice is per connection
 * and names no session, so a request may leave `sessionID` (and `directory`)
 * unset: every mounted controller then answers for its own session. The reads
 * belong to the controller (`syncSessionHistory`, `syncSessionTodo`); a
 * request no controller matches is dropped, because a later mount loads
 * history on activation anyway.
 */
export type SessionHistoryResync = {
  sequence: number
  directory?: string
  sessionID?: string
  reason: "sse-gap"
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
