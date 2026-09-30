import type { SessionId, SessionRef, SessionStatus } from "@/server"
import type { FetchedWindow, ListData } from "./model"

type Timed = { readonly at: number; readonly source: "event" | "read" }

function readIsStale(current: Timed | undefined, sentAt: number): boolean {
  if (!current) return false
  return current.source === "event" ? current.at >= sentAt : current.at > sentAt
}

export function statusChanged<S extends ListData>(data: S, ref: SessionRef, status: SessionStatus, at: number): S {
  const statuses = new Map(data.statuses)
  statuses.set(ref.sessionId, { status, at, source: "event", waitingOnUser: false })
  return { ...data, statuses }
}

export function statusRead<S extends ListData>(data: S, ref: SessionRef, status: SessionStatus, sentAt: number, waitingOnUser = false): S {
  if (readIsStale(data.statuses.get(ref.sessionId), sentAt)) return data
  const statuses = new Map(data.statuses)
  statuses.set(ref.sessionId, { status, at: sentAt, source: "read", waitingOnUser })
  return { ...data, statuses }
}

export function backgroundWorkChanged<S extends ListData>(data: S, ref: SessionRef, active: boolean, at: number): S {
  const backgroundWork = new Map(data.backgroundWork)
  backgroundWork.set(ref.sessionId, { active, at, source: "event" })
  return { ...data, backgroundWork }
}

export function backgroundWorkRead<S extends ListData>(data: S, ref: SessionRef, active: boolean, sentAt: number): S {
  if (readIsStale(data.backgroundWork.get(ref.sessionId), sentAt)) return data
  const backgroundWork = new Map(data.backgroundWork)
  backgroundWork.set(ref.sessionId, { active, at: sentAt, source: "read" })
  return { ...data, backgroundWork }
}

export function pageStatusesRead<S extends ListData>(data: S, window: FetchedWindow): S {
  let next = data
  for (const page of window.pages) {
    for (const row of page.rows) {
      const listed = page.statuses.get(row.ref.sessionId)
      if (!listed) continue
      next = statusRead(next, row.ref, listed.status, window.sentAt, listed.waitingOnUser)
      next = backgroundWorkRead(next, row.ref, listed.backgroundWork, window.sentAt)
    }
  }
  return next
}

export function withoutSessionFacts<S extends ListData>(data: S, sessionIds: Iterable<SessionId>): Pick<ListData, "statuses" | "backgroundWork"> {
  const statuses = new Map(data.statuses)
  const backgroundWork = new Map(data.backgroundWork)
  for (const sessionId of sessionIds) {
    statuses.delete(sessionId)
    backgroundWork.delete(sessionId)
  }
  return { statuses, backgroundWork }
}
