import { eventCursorCovers, parseEventCursor, type EventCursor } from "@claxedo/agent-runtime-contract"
import type { SessionLocation } from "./types"

export type SnapshotDatum = "first" | "row" | "open" | "queue"

export type SnapshotRead = {
  readonly landed: (cursor: string | null | undefined) => void
  readonly failed: () => void
}

export type SnapshotCoverage = {
  readonly attached: (ref: SessionLocation) => void
  readonly detached: (ref: SessionLocation) => void
  readonly reading: (ref: SessionLocation, datum: SnapshotDatum) => SnapshotRead
  readonly streamStarted: (ref: SessionLocation, since: string | null | undefined) => void
  readonly streamEnded: (ref: SessionLocation) => void
}

type Datum = { at: EventCursor | undefined; landed: boolean; reading: number }

type Attached = {
  start: { readonly id: number; readonly since: EventCursor | undefined } | undefined
  gapRaisedFor: number | undefined
  readonly data: Map<SnapshotDatum, Datum>
}

const IGNORED_READ: SnapshotRead = { landed: () => undefined, failed: () => undefined }

const key = (ref: SessionLocation) => `${ref.placementId}\u0000${ref.sessionId}`

function datumOf(session: Attached, datum: SnapshotDatum): Datum {
  const current = session.data.get(datum)
  if (current) return current
  const created: Datum = { at: undefined, landed: false, reading: 0 }
  session.data.set(datum, created)
  return created
}

type Judge = (ref: SessionLocation, session: Attached, datum: Datum) => void

function trackedRead(ref: SessionLocation, session: Attached, name: SnapshotDatum, judge: Judge): SnapshotRead {
  const datum = datumOf(session, name)
  datum.reading += 1
  let settled = false
  const settle = () => {
    if (settled) return false
    settled = true
    datum.reading -= 1
    return true
  }
  return {
    landed: (cursor) => {
      if (!settle()) return
      datum.at = parseEventCursor(cursor)
      datum.landed = true
      judge(ref, session, datum)
    },
    failed: () => void settle(),
  }
}

export function createSnapshotCoverage(onGap: (ref: SessionLocation) => void): SnapshotCoverage {
  const sessions = new Map<string, Attached>()
  let starts = 0
  const judge: Judge = (ref, session, datum) => {
    const start = session.start
    if (!start || eventCursorCovers(start.since, datum.at) || session.gapRaisedFor === start.id) return
    session.gapRaisedFor = start.id
    onGap(ref)
  }
  return {
    attached: (ref) => {
      if (!sessions.has(key(ref))) sessions.set(key(ref), { start: undefined, gapRaisedFor: undefined, data: new Map() })
    },
    detached: (ref) => void sessions.delete(key(ref)),
    reading: (ref, name) => {
      const session = sessions.get(key(ref))
      return session ? trackedRead(ref, session, name, judge) : IGNORED_READ
    },
    streamStarted: (ref, since) => {
      const session = sessions.get(key(ref))
      if (!session) return
      starts += 1
      session.start = { id: starts, since: parseEventCursor(since) }
      for (const datum of session.data.values()) if (datum.landed && datum.reading === 0) judge(ref, session, datum)
    },
    streamEnded: (ref) => {
      const session = sessions.get(key(ref))
      if (session) session.start = undefined
    },
  }
}
