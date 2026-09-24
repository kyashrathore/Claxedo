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

export function createOpenSessions(
  limit: number,
  owner: Owner | null,
  make: (ref: SessionRef) => SessionTranscript,
  onEvicted: (sessionId: SessionId) => void,
): OpenSessions {
  const entries = new Map<SessionId, OpenEntry>()

  function evict(sessionId: SessionId, entry: OpenEntry): void {
    entries.delete(sessionId)
    entry.view.dispose()
    entry.dispose()
    onEvicted(sessionId)
  }

  function evictBeyondLimit(): void {
    for (const [sessionId, entry] of entries) {
      if (entries.size <= limit) return
      evict(sessionId, entry)
    }
  }

  function get(ref: SessionRef): SessionTranscript {
    const hit = entries.get(ref.sessionId)
    if (hit) {
      entries.delete(ref.sessionId)
      entries.set(ref.sessionId, hit)
      return hit.view
    }
    const entry = createRoot((dispose) => ({ view: make(ref), dispose }), owner)
    entries.set(ref.sessionId, entry)
    evictBeyondLimit()
    return entry.view
  }

  return {
    get,
    byId: (sessionId) => entries.get(sessionId)?.view,
    forEach: (visit) => {
      for (const entry of entries.values()) visit(entry.view)
    },
    disposeAll: () => {
      for (const [sessionId, entry] of [...entries]) evict(sessionId, entry)
    },
  }
}
