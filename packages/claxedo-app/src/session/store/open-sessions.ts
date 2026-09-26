import { createRoot, type Owner } from "solid-js"
import type { SessionId, SessionRef } from "@/server"
import type { SessionTranscript } from "../transcript"

export const OPEN_SESSION_LIMIT = 8

type OpenEntry = { readonly view: SessionTranscript; readonly dispose: () => void }

export type OpenSessions = {
  readonly get: (ref: SessionRef) => SessionTranscript
  readonly byId: (sessionId: SessionId) => SessionTranscript | undefined
  readonly forEach: (visit: (view: SessionTranscript) => void) => void
  readonly disposeAll: () => void
}

type OpenState = {
  readonly entries: Map<SessionId, OpenEntry>
  readonly limit: number
  readonly owner: Owner | null
  readonly make: (ref: SessionRef) => SessionTranscript
  readonly onEvicted: (sessionId: SessionId) => void
}

function evict(open: OpenState, sessionId: SessionId, entry: OpenEntry): void {
  open.entries.delete(sessionId)
  entry.dispose()
  open.onEvicted(sessionId)
}

function evictBeyondLimit(open: OpenState): void {
  for (const [sessionId, entry] of open.entries) {
    if (open.entries.size <= open.limit) return
    evict(open, sessionId, entry)
  }
}

function get(open: OpenState, ref: SessionRef): SessionTranscript {
  const hit = open.entries.get(ref.sessionId)
  if (hit) {
    open.entries.delete(ref.sessionId)
    open.entries.set(ref.sessionId, hit)
    return hit.view
  }
  const entry = createRoot((dispose) => ({ view: open.make(ref), dispose }), open.owner)
  open.entries.set(ref.sessionId, entry)
  evictBeyondLimit(open)
  return entry.view
}

export function createOpenSessions(
  limit: number,
  owner: Owner | null,
  make: (ref: SessionRef) => SessionTranscript,
  onEvicted: (sessionId: SessionId) => void,
): OpenSessions {
  const open: OpenState = { entries: new Map(), limit, owner, make, onEvicted }
  return {
    get: (ref) => get(open, ref),
    byId: (sessionId) => open.entries.get(sessionId)?.view,
    forEach: (visit) => {
      for (const entry of open.entries.values()) visit(entry.view)
    },
    disposeAll: () => {
      for (const [sessionId, entry] of [...open.entries]) evict(open, sessionId, entry)
    },
  }
}
