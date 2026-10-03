import { unreachable } from "@/lib/machine"
import type { SessionRowView } from "@/session"

export type SessionActivity = "waiting" | "working" | "interrupted" | "failed" | "background" | "idle"

export type UnseenOutcome = "finished" | "failed"

export function sessionActivity(row: SessionRowView): SessionActivity {
  if (row.waitingOnUser) return "waiting"
  switch (row.status.kind) {
    case "working":
    case "retrying":
      return "working"
    case "interrupted":
      return "interrupted"
    case "failed":
      return "failed"
    case "runningInBackground":
      return "background"
    case "idle":
    case "unknown":
      return "idle"
    default:
      return unreachable(row.status)
  }
}

const OUTCOME: Readonly<Record<NonNullable<SessionRowView["lastTurn"]>["status"], UnseenOutcome | undefined>> = {
  completed: "finished",
  failed: "failed",
  cancelled: undefined,
}

export function unseenOutcome(row: SessionRowView): UnseenOutcome | undefined {
  const turn = row.lastTurn
  if (!turn || turn.completedAt <= (row.seenAt ?? 0)) return undefined
  const activity = sessionActivity(row)
  if (activity === "waiting" || activity === "working" || activity === "background") return undefined
  return OUTCOME[turn.status]
}

export type ActivityFilter = "all" | "working" | "needsYou"

export function canSettle(row: SessionRowView): boolean {
  if (row.pending) return false
  const activity = sessionActivity(row)
  return row.settled || (activity !== "waiting" && activity !== "working")
}

export function matchesActivityFilter(row: SessionRowView, filter: ActivityFilter): boolean {
  const activity = sessionActivity(row)
  switch (filter) {
    case "all":
      return true
    case "working":
      return row.pending || activity === "working" || activity === "background"
    case "needsYou":
      return activity === "waiting" || activity === "interrupted" || unseenOutcome(row) !== undefined
    default:
      return unreachable(filter)
  }
}
