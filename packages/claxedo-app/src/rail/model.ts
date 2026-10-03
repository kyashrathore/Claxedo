import { formatCompactAge } from "@/lib/relative-time"
import { sessionAttention, type MachineId, type Placement, type ProjectId, type SessionId, type SessionLocation } from "@/server"
import { sessionActivity, type SessionRowView } from "@/session"
import type { TerminalItem } from "@/terminal"

export type NavigationStatus = "idle" | "working" | "background" | "permission" | "error" | "interrupted" | "done"

export const SESSION_GROUP_PAGE_SIZE = 5

export function navigationStatus(row: SessionRowView): NavigationStatus {
  if (row.attention && row.executionAvailability?.status !== "available") return "idle"
  if (row.attention) {
    const attention = sessionAttention(row.attention, row.reader)
    if (row.attention.awaitingInput) return "permission"
    if (row.attention.working) return "working"
    if (attention.unseen) return row.attention.outcome?.status === "failed" ? "error" : "done"
    return "idle"
  }
  const activity = sessionActivity(row)
  if (activity === "waiting") return "permission"
  if (row.pending) return "working"
  switch (activity) {
    case "interrupted":
      return "interrupted"
    case "working":
      return "working"
    case "failed":
      return "idle"
    case "background":
      return "background"
    case "idle":
      return "idle"
  }
}

export type TerminalNavigationStatus = Exclude<NavigationStatus, "background" | "interrupted">

const TERMINAL_STATUS: Readonly<Record<NonNullable<TerminalItem["agentStatus"]>, TerminalNavigationStatus>> = {
  working: "working",
  waitingOnUser: "permission",
  failed: "error",
  idle: "idle",
}

export function terminalNavigationStatus(item: TerminalItem): TerminalNavigationStatus {
  const status = item.agentStatus ? TERMINAL_STATUS[item.agentStatus] : "idle"
  return status === "idle" && item.seen ? "done" : status
}

export function sessionAgeSince(row: SessionRowView): number {
  return row.createdAt || row.updatedAt
}

export function sessionAge(row: SessionRowView, now: number): string {
  return formatCompactAge(sessionAgeSince(row), now) ?? "<1m"
}

export function sessionIdsByProject(refs: readonly SessionLocation[]): ReadonlyMap<ProjectId, readonly SessionId[]> {
  const grouped = new Map<ProjectId, SessionId[]>()
  for (const ref of refs) {
    const group = grouped.get(ref.projectId)
    if (group) group.push(ref.sessionId)
    else grouped.set(ref.projectId, [ref.sessionId])
  }
  return grouped
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
