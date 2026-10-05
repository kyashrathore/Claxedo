import { unreachable } from "@/lib/machine"
import { formatCompactAge } from "@/lib/relative-time"
import { machineOfPlacement, type Machine, type Placement, type ProjectId, type SessionId, type SessionLocation } from "@/server"
import { sessionActivity, unseenOutcome, type SessionRowView, type UnseenOutcome } from "@/session"
import type { TerminalItem } from "@/terminal"

export type NavigationStatus = "idle" | "working" | "background" | "permission" | "error" | "interrupted" | "done"

export const SESSION_GROUP_PAGE_SIZE = 5

const UNSEEN_MARK: Readonly<Record<UnseenOutcome, NavigationStatus>> = { finished: "done", failed: "error" }

export function navigationStatus(row: SessionRowView): NavigationStatus {
  const activity = sessionActivity(row)
  if (activity === "waiting") return "permission"
  if (row.pending) return "working"
  switch (activity) {
    case "interrupted":
      return "interrupted"
    case "working":
      return "working"
    case "background":
      return "background"
    case "failed":
    case "idle": {
      const unseen = unseenOutcome(row)
      return unseen ? UNSEEN_MARK[unseen] : "idle"
    }
    default:
      return unreachable(activity)
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

export type SessionMarker =
  | { readonly kind: "cloud"; readonly name: string }
  | { readonly kind: "machine"; readonly name: string; readonly folder: string }
  | { readonly kind: "worktree"; readonly name: string; readonly path: string | undefined }

export function sessionMarker(placement: Placement | undefined, machines: readonly Machine[]): SessionMarker | undefined {
  if (!placement) return undefined
  if (placement.kind === "cloud") return { kind: "cloud", name: placement.label }
  const machine = placement.onThisMachine ? undefined : machineOfPlacement(machines, placement)
  if (machine) return { kind: "machine", name: machine.name, folder: placement.label }
  return placement.kind === "worktree" ? { kind: "worktree", name: placement.label, path: placement.path } : undefined
}
