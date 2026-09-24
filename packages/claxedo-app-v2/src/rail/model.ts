import { formatCompactAge } from "@/lib/relative-time"
import type { ProjectId } from "@/server"
import type { SessionRowView } from "@/session"
import type { TerminalItem } from "@/terminal"

export type NavigationStatus = "idle" | "working" | "permission" | "error"

export const SESSION_GROUP_PAGE_SIZE = 5

export function navigationStatus(row: SessionRowView): NavigationStatus {
  if (row.waitingOnUser) return "permission"
  if (row.pending) return "working"
  switch (row.status.kind) {
    case "working":
    case "retrying":
    case "recovering":
      return "working"
    case "failed":
      return "error"
    default:
      return "idle"
  }
}

export function sessionAge(row: SessionRowView, now: number): string {
  return formatCompactAge(row.createdAt || row.updatedAt, now) ?? "<1m"
}

export function rowsByProject(rows: readonly SessionRowView[]): ReadonlyMap<ProjectId, readonly SessionRowView[]> {
  const grouped = new Map<ProjectId, SessionRowView[]>()
  for (const row of rows) {
    if (row.archivedAt !== undefined || row.parentSessionId !== undefined) continue
    const group = grouped.get(row.ref.projectId)
    if (group) group.push(row)
    else grouped.set(row.ref.projectId, [row])
  }
  return grouped
}

export function siblingAfterArchive(rows: readonly SessionRowView[], archived: SessionRowView): SessionRowView | undefined {
  const index = rows.findIndex((row) => row.ref.sessionId === archived.ref.sessionId)
  if (index === -1) return undefined
  return rows[index + 1] ?? rows[index - 1]
}

export type RailRow =
  | { readonly kind: "terminal"; readonly key: string; readonly terminal: TerminalItem }
  | { readonly kind: "session"; readonly key: string; readonly session: SessionRowView }

export function railRows(terminals: readonly TerminalItem[], sessions: readonly SessionRowView[]): readonly RailRow[] {
  return [
    ...terminals.map((terminal): RailRow => ({ kind: "terminal", key: `terminal:${terminal.placementId}:${terminal.terminalId}`, terminal })),
    ...sessions.map((session): RailRow => ({ kind: "session", key: `session:${session.ref.sessionId}`, session })),
  ]
}
