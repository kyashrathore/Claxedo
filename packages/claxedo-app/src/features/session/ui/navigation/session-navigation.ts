import { terminalSurfaceStatus } from "@/features/session/app-ports"
import type { WORKBENCH_DRAG_MIME } from "@/features/session/app-ports"
import type { ContentMeta, TerminalAgentStatus, TerminalLifecycleState } from "@/features/session/app-ports"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"
import type { SessionOwner } from "@/features/session/data/query/types"

type WorkspaceDirectory = string

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
  /** Session creator — owner favicon on shared/other-user rail rows. */
  owner?: SessionOwner
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
  return input.rows.map((row) => row.sessionRef === input.sessionRef
    ? { ...row, archivedAt: input.archivedAt }
    : row
  )
}

export function terminalMetaMatchesPlacement(meta: ContentMeta, placement: string) {
  if (meta.type !== "terminal" || !meta.terminalId || !meta.directory) return false
  return terminalSurfaceMatchesDirectory(meta, placement)
}

function terminalSurfaceMatchesDirectory(meta: ContentMeta, directory: WorkspaceDirectory) {
  // Fixture/bootstrap inventory often stores the macOS-realpath form
  // (`/private/var/...`) while the client launch path still carries `/var/...`.
  // Reuse the signed-workspace alias so rail placement matches the open pane.
  if (sameWorkspaceDirectory(meta.directory, directory)) return true
  if (
    meta.directory === `workspace:${directory}` ||
    directory === `workspace:${meta.directory}`
  ) return true
  const routeId = meta.content?.type === "terminal" ? meta.content.workspaceRouteId : undefined
  if (!routeId) return false
  return directory === routeId || directory === `workspace:${routeId}`
}

export function deriveTerminalSurfaceRows(input: {
  metas: readonly ContentMeta[]
  focusedContentId?: string
  isActive?: (contentId: string) => boolean
  directory?: string
  agentStatus?: Record<string, TerminalAgentStatus | undefined>
  agentSeen?: Record<string, true | undefined>
  lifecycle?: Record<string, TerminalLifecycleState | undefined>
}): TerminalSurfaceRow[] {
  return input.metas
    .filter((meta): meta is ContentMeta & { terminalId: string; directory: WorkspaceDirectory } =>
      meta.type === "terminal" &&
      !!meta.terminalId &&
      !!meta.directory &&
      (!input.directory || terminalSurfaceMatchesDirectory(meta, input.directory))
    )
    .map((meta) => {
      const row: TerminalSurfaceRow = {
        type: "terminal",
        contentId: meta.id,
        terminalId: meta.terminalId,
        title: meta.content?.title?.trim() || "Terminal",
        directory: meta.directory,
        activity: terminalActivityDetail({
          status: input.agentStatus?.[meta.terminalId],
          seen: input.agentSeen?.[meta.terminalId],
        }),
        active: false,
        ...(input.lifecycle?.[meta.terminalId] === "creating" ? { pending: true } : {}),
      }
      if (input.isActive) {
        Object.defineProperty(row, "active", {
          enumerable: true,
          get: () => input.isActive?.(meta.id) ?? false,
        })
      } else {
        row.active = meta.id === input.focusedContentId
      }
      return row
    })
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

function terminalActivityDetail(input: {
  status?: TerminalAgentStatus
  seen?: boolean
}): RowActivityDetail {
  const status = terminalSurfaceStatus(input)
  if (status === "permission") return { state: "needs_input", source: "event", inputKind: "permission" }
  if (status === "working") return { state: "working", source: "event" }
  if (status === "done") return { state: "done", source: "event" }
  return { state: "idle", source: "initial" }
}
