import { createRoot, type Owner } from "solid-js"
import type { SessionId, SessionOutline, SessionLocation, TranscriptPage } from "@/server"
import type { SessionTranscript, TranscriptSeed } from "../transcript"

export const OPEN_SESSION_LIMIT = 8
export const CACHED_TURN_LIMIT = 32

type CachedSession = {
  readonly kind: "cached"
  readonly latestTurn: TranscriptPage
  readonly outline: SessionOutline | undefined
  readonly stamp: number
}

type OpenEntry = { readonly kind: "open"; readonly view: SessionTranscript; readonly dispose: () => void } | CachedSession

export type OpenSessions = {
  readonly get: (ref: SessionLocation) => SessionTranscript
  readonly byId: (sessionId: SessionId) => SessionTranscript | undefined
  readonly forgetCached: (sessionId?: SessionId) => void
  readonly counts: () => { readonly open: number; readonly cached: number }
  readonly forEach: (visit: (view: SessionTranscript) => void) => void
  readonly disposeAll: () => void
}

export type OpenSessionsInput = {
  readonly limit: number
  readonly cachedLimit: number
  readonly owner: Owner | null
  readonly make: (ref: SessionLocation, seed?: TranscriptSeed) => SessionTranscript
  readonly onEvicted: (sessionId: SessionId) => void
  readonly stamp: (sessionId: SessionId) => number | undefined
}

type OpenState = OpenSessionsInput & { readonly entries: Map<SessionId, OpenEntry> }

function count(open: OpenState, kind: OpenEntry["kind"]) {
  let total = 0
  for (const entry of open.entries.values()) if (entry.kind === kind) total += 1
  return total
}

function evictCachedBeyondLimit(open: OpenState): void {
  for (const [id, held] of open.entries) {
    if (count(open, "cached") <= open.cachedLimit) return
    if (held.kind === "cached") open.entries.delete(id)
  }
}

function cache(open: OpenState, sessionId: SessionId, entry: CachedSession): void {
  open.entries.set(sessionId, entry)
  evictCachedBeyondLimit(open)
}

function evictOpenBeyondLimit(open: OpenState): void {
  for (const [sessionId, entry] of open.entries) {
    if (count(open, "open") <= open.limit) return
    if (entry.kind !== "open") continue
    const retained = entry.view.retained()
    open.entries.delete(sessionId)
    entry.dispose()
    open.onEvicted(sessionId)
    const stamp = open.stamp(sessionId)
    if (!retained || stamp === undefined) continue
    cache(open, sessionId, { kind: "cached", latestTurn: retained.latestTurn, outline: retained.outline, stamp })
  }
}

function seedOf(open: OpenState, sessionId: SessionId, entry: OpenEntry | undefined): TranscriptSeed | undefined {
  if (entry?.kind !== "cached" || entry.stamp !== open.stamp(sessionId)) return undefined
  return { latestTurn: entry.latestTurn, outline: entry.outline }
}

function touchOrOpen(open: OpenState, ref: SessionLocation): SessionTranscript {
  const hit = open.entries.get(ref.sessionId)
  if (hit?.kind === "open") {
    open.entries.delete(ref.sessionId)
    open.entries.set(ref.sessionId, hit)
    return hit.view
  }
  open.entries.delete(ref.sessionId)
  const seed = seedOf(open, ref.sessionId, hit)
  const entry = createRoot((dispose) => ({ kind: "open" as const, view: open.make(ref, seed), dispose }), open.owner)
  open.entries.set(ref.sessionId, entry)
  evictOpenBeyondLimit(open)
  return entry.view
}

function forgetCached(open: OpenState, sessionId?: SessionId): void {
  for (const [id, entry] of Array.from(open.entries)) {
    if (entry.kind === "cached" && (sessionId === undefined || id === sessionId)) open.entries.delete(id)
  }
}

export function createOpenSessions(input: OpenSessionsInput): OpenSessions {
  const open: OpenState = { ...input, entries: new Map() }
  return {
    get: (ref) => touchOrOpen(open, ref),
    byId: (sessionId) => {
      const entry = open.entries.get(sessionId)
      return entry?.kind === "open" ? entry.view : undefined
    },
    forgetCached: (sessionId) => forgetCached(open, sessionId),
    counts: () => ({ open: count(open, "open"), cached: count(open, "cached") }),
    forEach: (visit) => {
      for (const entry of open.entries.values()) if (entry.kind === "open") visit(entry.view)
    },
    disposeAll: () => {
      for (const [sessionId, entry] of Array.from(open.entries)) {
        open.entries.delete(sessionId)
        if (entry.kind !== "open") continue
        entry.dispose()
        open.onEvicted(sessionId)
      }
    },
  }
}
