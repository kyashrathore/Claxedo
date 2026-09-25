import type { SessionRef, SessionStatus } from "@/server"
import type { FetchedWindow, ListData } from "./model"

export function statusChanged<S extends ListData>(data: S, ref: SessionRef, status: SessionStatus, at: number): S {
  const statuses = new Map(data.statuses)
  statuses.set(ref.sessionId, { status, at, source: "event", waitingOnUser: false })
  return { ...data, statuses }
}

export function statusRead<S extends ListData>(data: S, ref: SessionRef, status: SessionStatus, sentAt: number, waitingOnUser = false): S {
  const current = data.statuses.get(ref.sessionId)
  if (current && current.source === "event" && current.at >= sentAt) return data
  if (current && current.source === "read" && current.at > sentAt) return data
  const statuses = new Map(data.statuses)
  statuses.set(ref.sessionId, { status, at: sentAt, source: "read", waitingOnUser })
  return { ...data, statuses }
}

export function pageStatusesRead<S extends ListData>(data: S, window: FetchedWindow): S {
  let next = data
  for (const page of window.pages) {
    for (const row of page.rows) {
      const listed = page.statuses.get(row.ref.sessionId)
      if (listed) next = statusRead(next, row.ref, listed.status, window.sentAt, listed.waitingOnUser)
    }
  }
  return next
}
