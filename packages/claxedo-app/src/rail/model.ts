import { formatCompactAge } from "@/lib/relative-time"
import type { MachineId, Placement, ProjectId, SessionId, SessionRef } from "@/server"
import type { SessionRowView } from "@/session"
import type { TerminalItem } from "@/terminal"

export type NavigationStatus = "idle" | "working" | "permission" | "error" | "done"

export const SESSION_GROUP_PAGE_SIZE = 5

export function navigationStatus(row: SessionRowView, failureUnseen: boolean): NavigationStatus {
  if (row.waitingOnUser) return "permission"
  if (row.pending) return "working"
  switch (row.status.kind) {
    case "working":
    case "retrying":
    case "recovering":
      return "working"
    case "failed":
      return failureUnseen ? "error" : "idle"
    default:
      return "idle"
  }
}

const TERMINAL_STATUS: Readonly<Record<NonNullable<TerminalItem["agentStatus"]>, NavigationStatus>> = {
  working: "working",
  waitingOnUser: "permission",
  failed: "error",
  idle: "idle",
}

export function terminalNavigationStatus(item: TerminalItem): NavigationStatus {
  const status = item.agentStatus ? TERMINAL_STATUS[item.agentStatus] : "idle"
  return status === "idle" && item.seen ? "done" : status
}

export function sessionAgeSince(row: SessionRowView): number {
  return row.createdAt || row.updatedAt
}

export function sessionAge(row: SessionRowView, now: number): string {
  return formatCompactAge(sessionAgeSince(row), now) ?? "<1m"
}

export function sessionIdsByProject(refs: readonly SessionRef[]): ReadonlyMap<ProjectId, readonly SessionId[]> {
  const grouped = new Map<ProjectId, SessionId[]>()
  for (const ref of refs) {
    const group = grouped.get(ref.projectId)
    if (group) group.push(ref.sessionId)
    else grouped.set(ref.projectId, [ref.sessionId])
  }
  return grouped
}

export function siblingAfterArchive(sessionIds: readonly SessionId[], archived: SessionId): SessionId | undefined {
  const index = sessionIds.indexOf(archived)
  if (index === -1) return undefined
  return sessionIds[index + 1] ?? sessionIds[index - 1]
}

export type RailRow =
  | { readonly kind: "terminal"; readonly key: string; readonly terminal: TerminalItem }
  | { readonly kind: "session"; readonly key: string; readonly session: SessionRowView }

export const terminalRowKey = (terminal: TerminalItem) => `terminal:${terminal.placementId}:${terminal.terminalId}`

export const sessionRowKey = (sessionId: SessionId) => `session:${sessionId}`

export type SessionMarkerKind = "cloud" | "machine" | "worktree"

export type SessionMarker = { readonly kind: SessionMarkerKind; readonly name: string; readonly path: string | undefined }

export function sessionMarker(placement: Placement | undefined, thisMachine: MachineId | undefined): SessionMarker | undefined {
  if (!placement) return undefined
  const name = placement.label
  if (placement.kind === "cloud") return { kind: "cloud", name, path: undefined }
  if (placement.machineId && placement.machineId !== thisMachine) return { kind: "machine", name, path: undefined }
  return placement.kind === "worktree" ? { kind: "worktree", name, path: placement.path } : undefined
}
