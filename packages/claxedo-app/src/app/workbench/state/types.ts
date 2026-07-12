// Composed state types for the claxedo state layer.
//
// `ClaxedoState` wraps Workbench state and adds the slices the rest of the app needs
// (metadata, terminal, workspace, rail, workspace-panel, process-pane).
//
// `ContentMeta` is the registry entry for one Workbench `contentId`, carrying
// display/identity information (type, directory, sessionId, terminalId, title,
// etc.) plus the live payload needed by renderers.

import type { WorkbenchState } from "../workbench/index"
import type {
  WorkspacePanelState,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import type { SessionRef } from "@/platform/identity/session-ref"

// ── Content type vocabulary ───────────────────────────────────────────────
export const CONTENT_TYPES = [
  "session",
  "draft-session",
  "terminal",
  "context",
  "pages-index",
  "page",
  "marketplace",
] as const

export type ContentType = typeof CONTENT_TYPES[number]

export type ContentScope = "directory" | "global"
export type DraftSessionPanel = "attach" | "create"

// ── Live content payload ──────────────────────────────────────────────────
type ContentIntent = {
  name?: string
  role?: string
  refs?: string[]
  defaults?: {
    agent?: string
    system?: string
    prompt?: string
  }
  meta?: Record<string, string>
}

type BaseContentPayload = {
  title?: string
  command?: string
  sessionId?: string
  sessionRef?: SessionRef
  terminalId?: string
  filePath?: string
  pageId?: string
  processId?: string
  intent?: ContentIntent
}

export type PageContentPayload = BaseContentPayload & {
  type: "page"
  pageId: string
  directory?: string
}

export type PagesIndexContentPayload = BaseContentPayload & {
  type: "pages-index"
  directory?: string
}

export type MarketplaceContentPayload = BaseContentPayload & {
  type: "marketplace"
  directory?: string
}

export type DraftSessionContentPayload = BaseContentPayload & {
  type: "draft-session"
  draftId: string
  providerDirectory: string
  directory?: string
}

export type SessionContentPayload = BaseContentPayload & {
  type: "session"
  directory?: string
  sessionId: string
}

export type ScopedContentPayload = BaseContentPayload & {
  type: Exclude<ContentType, "session" | "draft-session" | "page" | "pages-index" | "marketplace">
  directory: string
}

export type ContentPayload =
  | PageContentPayload
  | PagesIndexContentPayload
  | MarketplaceContentPayload
  | DraftSessionContentPayload
  | SessionContentPayload
  | ScopedContentPayload

// ── ContentMeta — the per-content registry entry ──────────────────────────
export type ContentMeta = {
  /** Stable id (matches the Workbench `contentId`). */
  id: string
  type: ContentType
  scope?: ContentScope
  directory?: string
  draftId?: string
  providerDirectory?: string
  draftPanel?: DraftSessionPanel
  draftProjectId?: string
  sessionId?: string
  terminalId?: string
  filePath?: string
  pageId?: string
  /** Live runtime content payload (title, intent, command, etc.). */
  content?: ContentPayload
}

const GLOBAL_CONTENT_TYPES: ReadonlySet<ContentType> = new Set<ContentType>([
  "page",
  "pages-index",
  "marketplace",
])

export function isGlobalContent(content: Pick<ContentMeta, "type" | "scope" | "directory">) {
  return GLOBAL_CONTENT_TYPES.has(content.type) && content.scope === "global" && !content.directory
}

export function realDirectory(dir?: string | null) {
  if (!dir || dir === "__process__") return
  return dir
}

export function contentScopeDir(content: Pick<ContentMeta, "type" | "scope" | "directory">, dir?: string | null) {
  if (isGlobalContent(content)) return
  if (content.type === "context") return realDirectory(dir) ?? realDirectory(content.directory)
  return realDirectory(content.directory)
}

// ── Slice shapes ──────────────────────────────────────────────────────────
export type RailSlice = {
  collapsed: boolean
  hovered: boolean
  pinned: boolean
  locked: boolean
  width?: number
}

export type TerminalAgentStatus = "idle" | "working" | "permission"
export type TerminalLifecycleState = "creating" | "attaching" | "attached" | "closing" | "closed"

export type TerminalSlice = {
  /** terminalId → owning content id (the content that "links" the terminal). */
  owner: Record<string, string | undefined>
  agentStatus: Record<string, TerminalAgentStatus | undefined>
  agentSeen: Record<string, true | undefined>
  lifecycle: Record<string, TerminalLifecycleState | undefined>
}

export type WorkspaceSlice = {
  /** Per-pane working-directory pin/default. Keyed by Workbench paneId. */
  paneWorktree: Record<string, { default: string | null; pinned: string | null }>
  /** projectId → recently-accessed worktree directories (most recent first). */
  recency: Record<string, string[]>
  /** directory → assigned color (persisted so colors stay stable). */
  worktreeColor: Record<string, string>
}

export type ProcessPaneSlice = {
  /** True when a process crashed while the pane is closed. */
  crashedWhileClosed: boolean
  /** Action requested from tab-bar buttons. */
  pendingAction: "startAll" | "stopAll" | "add" | null
}

// ── Composed state ────────────────────────────────────────────────────────
export type ClaxedoState = {
  /** Phase 1 Workbench state — panes, split tree, contentIds, focus. */
  workbench: WorkbenchState
  /** Per-content registry keyed by contentId (== Workbench contentId). */
  meta: Record<string, ContentMeta>
  rail: RailSlice
  workspace: WorkspaceSlice
  workspacePanel: WorkspacePanelState
  terminal: TerminalSlice
  processPane: ProcessPaneSlice
}
