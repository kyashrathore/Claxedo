import type { PlacementId, SessionRef, SessionRow, SessionStatus, SessionStatusRead } from "@/server"
import type { ListData } from "./model"

export function statusChanged<S extends ListData>(data: S, ref: SessionRef, status: SessionStatus, at: number): S {
  const statuses = new Map(data.statuses)
  statuses.set(ref.sessionId, { status, at, source: "event" })
  return { ...data, statuses }
}

export function statusRead<S extends ListData>(data: S, ref: SessionRef, status: SessionStatus, sentAt: number): S {
  const current = data.statuses.get(ref.sessionId)
  if (current && current.source === "event" && current.at >= sentAt) return data
  if (current && current.source === "read" && current.at > sentAt) return data
  const statuses = new Map(data.statuses)
  statuses.set(ref.sessionId, { status, at: sentAt, source: "read" })
  return { ...data, statuses }
}

export const unreadPlacementsOf = (read: SessionStatusRead): ReadonlySet<PlacementId> =>
  new Set(read.failures.map((failure) => failure.placementId))

export function statusesRead<S extends ListData>(data: S, read: SessionStatusRead, sentAt: number, rows: readonly SessionRow[]): S {
  const reported = new Set<string>()
  const unreadPlacements = unreadPlacementsOf(read)
  let next: S = { ...data, unreported: { status: read.unreported, sentAt, unreadPlacements } }
  for (const report of read.reports) {
    reported.add(report.ref.sessionId)
    next = statusRead(next, report.ref, report.status, sentAt)
  }
  for (const row of rows) {
    if (reported.has(row.ref.sessionId) || unreadPlacements.has(row.ref.placementId)) continue
    next = statusRead(next, row.ref, read.unreported, sentAt)
  }
  return next
}

export function fillUnreported<S extends ListData>(data: S, rows: readonly SessionRow[]): S {
  const fill = data.unreported
  if (!fill) return data
  let next = data
  for (const row of rows) {
    if (next.statuses.has(row.ref.sessionId) || fill.unreadPlacements.has(row.ref.placementId)) continue
    next = statusRead(next, row.ref, fill.status, fill.sentAt)
  }
  return next
}
