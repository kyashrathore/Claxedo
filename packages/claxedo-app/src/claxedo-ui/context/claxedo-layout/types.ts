export type ReviewMode = "session-turn" | "session" | "staged" | "uncommitted" | "vs-base" | "to-from"

export type TabType =
  | "session"
  | "terminal"
  | "review"
  | "review-workspace"
  | "file"
  | "context"
  | "pages-index"
  | "page"
  | "workgraph"
  | "multi-pane"
  | "process"
  | "filetree"
  | "browser"

export type TabScope = "directory" | "global"

export type TabItem = {
  id: string
  type: TabType
  scope?: TabScope
  directory?: string
  title: string
  sessionId?: string
  terminalId?: string
  filePath?: string
  pageId?: string
  reviewMode?: ReviewMode
  reviewFromRef?: string
  reviewToRef?: string
  reviewFocusPath?: string
  reviewFocusVersion?: number
  badge?: {
    additions: number
    deletions: number
  }
  closable: boolean
  pinned?: boolean
  loading?: boolean
  attention?: boolean
  done?: boolean
  /** When true, panes scroll horizontally instead of being squeezed to fit */
  scrollable?: boolean
  /** Minimum pane width in px when scrollable is true (default: 400) */
  minPaneWidth?: number
  /** Stable identifier for a browser tab's underlying webview lifecycle */
  browserId?: string
  /** Current URL the browser tab is showing */
  currentUrl?: string
  /** Last-seen page title — used by the browser tab for its tab label */
  pageTitle?: string
}

export type RailState = {
  collapsed: boolean
  hovered: boolean
  pinned: boolean
  locked: boolean
}

export type TopTabsState = {
  items: TabItem[]
  activeId: string | null
  order: string[]
  closedTabs: TabItem[]
}

export type WorktreeState = {
  default: string | null
  pinned: string | null
}

export type PaneDir = "h" | "v"

export type Pane = { t: "leaf"; id: string } | { t: "split"; dir: PaneDir; a: Pane; b: Pane; size: number }

export type TerminalActionOrigin = { tabId: string; groupId: string; hostId: string }

export type TerminalAgentStatus = "idle" | "working" | "permission"

export type TerminalLifecycleState = "creating" | "attaching" | "attached" | "closing" | "closed"

export type GroupLayoutState = Record<string, never>

export const defaultGroupLayout = (): GroupLayoutState => ({})

export type GroupState = {
  id: string
  tabs: TopTabsState
  worktree: WorktreeState
  layout: GroupLayoutState
}

export type SplitState = {
  direction: "h" | "v"
  sizes: number[]
  focusedId: string
  hidden?: boolean
}

export type ProcessPaneState = {
  /** Monotonically increasing counter — each bump is a toggle request from the keyboard shortcut */
  toggleVersion: number
  /** Set to true when switching workspaces and the pane should open — consumed once by ProcessPaneProvider on mount */
  pendingOpen: boolean
  /** Optional directory target for the next/active process pane view. */
  targetDirectory: string | null
  /** Set to true when a process crashes while the pane is closed — cleared when the pane opens */
  crashedWhileClosed: boolean
  /** Action requested from tab bar buttons, consumed by ProcessPaneProvider */
  pendingAction: "startAll" | "stopAll" | "add" | null
}

type PaneIntent = {
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

type BasePaneContent = {
  title?: string
  command?: string
  sessionId?: string
  terminalId?: string
  filePath?: string
  pageId?: string
  processId?: string
  reviewMode?: ReviewMode
  reviewFromRef?: string
  reviewToRef?: string
  intent?: PaneIntent
}

export type PagePaneContent = BasePaneContent & {
  type: "page"
  pageId: string
  directory?: string
}

export type PagesIndexPaneContent = BasePaneContent & {
  type: "pages-index"
  directory?: string
}

export type WorkgraphPaneContent = BasePaneContent & {
  type: "workgraph"
  directory?: string
}

export type ScopedPaneContent = BasePaneContent & {
  type: Exclude<TabType, "page" | "pages-index" | "workgraph" | "multi-pane">
  directory: string
}

export type PaneContent = PagePaneContent | PagesIndexPaneContent | WorkgraphPaneContent | ScopedPaneContent

export type PaneLayout = {
  id: string
  name: string
  icon?: string
  pane: Pane
  contents: Record<string, PaneContent>
  focus?: string
  zoom?: string
  /** LeafId of a session pane rendered as a floating CompactPromptDock overlay */
  floating?: string
}

export type MultiPaneTabState = {
  layouts: PaneLayout[]
  activeLayoutId: string
}

export type ClaxedoLayoutStore = {
  rail: RailState
  groups: GroupState[]
  split: SplitState
  enabled: boolean
  terminalOwner: Record<string, string | undefined>
  terminalAgentStatus: Record<string, TerminalAgentStatus | undefined>
  terminalAgentSeen: Record<string, true | undefined>
  terminalLifecycle: Record<string, TerminalLifecycleState | undefined>
  workspaceRecency: Record<string, string[]>
  /** Persisted directory → color assignments for worktree indicators */
  worktreeColorMap: Record<string, string>
  /** Process pane open/close state (app-level, shared across directory scopes) */
  processPane: ProcessPaneState
  /** Per-tab multi-pane layout state */
  multiPane: Record<string, MultiPaneTabState | undefined>
}

export const createEmptyTabsState = (): TopTabsState => ({
  items: [],
  activeId: null,
  order: [],
  closedTabs: [],
})

export const GLOBAL_TAB_TYPES: ReadonlySet<TabType> = new Set<TabType>(["page", "pages-index", "workgraph"])

export function isGlobalTab(tab: Pick<TabItem, "type" | "scope" | "directory">) {
  return GLOBAL_TAB_TYPES.has(tab.type) && tab.scope === "global" && !tab.directory
}

export function isGlobalPane(content: Pick<PaneContent, "type" | "directory">) {
  return GLOBAL_TAB_TYPES.has(content.type) && !content.directory
}

export function realDirectory(dir?: string | null) {
  if (!dir || dir === "__process__") return
  return dir
}

export function tabScopeDir(tab: Pick<TabItem, "type" | "scope" | "directory">, dir?: string | null) {
  if (isGlobalTab(tab)) return
  if (tab.type === "review" || tab.type === "review-workspace" || tab.type === "context" || tab.type === "file") {
    return realDirectory(dir) ?? realDirectory(tab.directory)
  }
  return realDirectory(tab.directory)
}

/** Create a process tab item for a group. */
export function makeProcessTab(groupId: string, directory: string): TabItem {
  return {
    id: `process-tab-${groupId}`,
    type: "process",
    scope: "directory",
    directory,
    title: "Processes",
    closable: false,
    pinned: true,
  }
}
