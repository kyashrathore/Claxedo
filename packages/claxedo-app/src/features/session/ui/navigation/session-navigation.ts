import { terminalSurfaceStatus } from "@/features/session/app-ports"
import type { WORKBENCH_DRAG_MIME } from "@/features/session/app-ports"
import type { ContentMeta, TerminalAgentStatus, TerminalLifecycleState } from "@/features/session/app-ports"

export type RowActivity = "idle" | "working" | "needs_input" | "done"

export type RowActivityDetail = {
  state: RowActivity
  source: "event" | "poll" | "optimistic" | "initial"
  inputKind?: "permission" | "question"
  requestIds?: string[]
  stale?: boolean
}

export type SessionNavigationRow = {
  type: "session"
  sessionRef: string
  sessionId: string
  title: string
  directory: string
  workspaceId?: string
  projectId?: string
  createdAt: number
  updatedAt: number
  archivedAt?: number
  tags: string[]
  attachments: Array<{ kind: string; targetId?: string }>
  environment?: { kind?: string; driver?: string }
  git?: { repo?: string; branch?: string; remote?: string }
}

export type TerminalSurfaceRow = {
  type: "terminal"
  contentId: string
  terminalId: string
  title: string
  directory: string
  activity: RowActivityDetail
  active: boolean
  pending?: boolean
}

export type NavigationCommand =
  | { type: "openSession"; sessionRef: string }
  | { type: "openTerminal"; contentId: string; terminalId: string }
  | { type: "archiveSession"; sessionRef: string }
  | { type: "closeTerminal"; contentId: string; terminalId: string }
  | { type: "prepareSessionDrag"; sessionRef: string }

export type NavigationDragPayload =
  | { type: "session"; sessionRef: string; contentId?: string }
  | { type: "terminal"; terminalId: string; contentId: string }

export type NavigationDragStart = {
  event: DragEvent
  row: SessionNavigationRow | TerminalSurfaceRow
  payload: NavigationDragPayload
  setWorkbenchDragData: (contentId: string) => void
}

export function reconcileSessionRowsAfterArchive(input: {
  rows: readonly SessionNavigationRow[]
  sessionRef: string
  archivedAt: number
  archiveView: "active" | "all" | "archived"
}) {
  if (input.archiveView === "active") {
    return input.rows.filter((row) => row.sessionRef !== input.sessionRef)
  }
  return input.rows.map((row) => (row.sessionRef === input.sessionRef ? { ...row, archivedAt: input.archivedAt } : row))
}

export function deriveTerminalSurfaceRows(input: {
  metas: readonly ContentMeta[]
  focusedContentId?: string
  directory?: string
  agentStatus?: Record<string, TerminalAgentStatus | undefined>
  agentSeen?: Record<string, true | undefined>
  lifecycle?: Record<string, TerminalLifecycleState | undefined>
}): TerminalSurfaceRow[] {
  return input.metas
    .filter(
      (meta): meta is ContentMeta & { terminalId: string; directory: string } =>
        meta.type === "terminal" &&
        !!meta.terminalId &&
        !!meta.directory &&
        (!input.directory || meta.directory === input.directory),
    )
    .map((meta) => ({
      type: "terminal",
      contentId: meta.id,
      terminalId: meta.terminalId,
      title: meta.content?.title?.trim() || "Terminal",
      directory: meta.directory,
      activity: terminalActivityDetail({
        status: input.agentStatus?.[meta.terminalId],
        seen: input.agentSeen?.[meta.terminalId],
      }),
      active: meta.id === input.focusedContentId,
      ...(input.lifecycle?.[meta.terminalId] === "creating" ? { pending: true } : {}),
    }))
}

export function navigationDragPayload(row: SessionNavigationRow | TerminalSurfaceRow): NavigationDragPayload {
  if (row.type === "session") return { type: "session", sessionRef: row.sessionRef }
  return { type: "terminal", terminalId: row.terminalId, contentId: row.contentId }
}

export function setWorkbenchDragMime(input: {
  dataTransfer?: Pick<DataTransfer, "setData" | "effectAllowed">
  mime: typeof WORKBENCH_DRAG_MIME
  contentId: string
}) {
  input.dataTransfer?.setData(input.mime, input.contentId)
  if (input.dataTransfer) input.dataTransfer.effectAllowed = "copy"
}

function terminalActivityDetail(input: { status?: TerminalAgentStatus; seen?: boolean }): RowActivityDetail {
  const status = terminalSurfaceStatus(input)
  if (status === "permission") return { state: "needs_input", source: "event", inputKind: "permission" }
  if (status === "working") return { state: "working", source: "event" }
  if (status === "done") return { state: "done", source: "event" }
  return { state: "idle", source: "initial" }
}
