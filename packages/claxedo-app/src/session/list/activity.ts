import type { SessionRowView } from "@/session"

export type SessionActivity = "waiting" | "working" | "failed" | "idle"

export function sessionActivity(row: SessionRowView): SessionActivity {
  if (row.waitingOnUser) return "waiting"
  switch (row.status.kind) {
    case "working":
    case "retrying":
    case "recovering":
      return "working"
    case "failed":
      return "failed"
    case "idle":
    case "unknown":
      return row.backgroundWork ? "working" : "idle"
  }
}
