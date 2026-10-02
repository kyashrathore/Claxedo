import { unreachable } from "@/lib/machine"
import type { SessionRowView } from "@/session"

export type SessionActivity = "waiting" | "working" | "failed" | "background" | "idle"

export function sessionActivity(row: SessionRowView): SessionActivity {
  if (row.waitingOnUser) return "waiting"
  switch (row.status.kind) {
    case "working":
    case "retrying":
    case "recovering":
      return "working"
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
