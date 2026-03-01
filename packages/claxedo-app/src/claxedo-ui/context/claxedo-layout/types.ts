export type ReviewMode = "session-turn" | "session" | "staged" | "committed" | "uncommitted" | "vs-base" | "to-from"

export type TabType = "session" | "terminal" | "review" | "file" | "context" | "page" | "multi-pane"

export type TabItem = {
  id: string
  type: TabType
  directory: string
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

export type GroupLayoutState = {
  fileTree: { opened: boolean; width: number }
}

export const defaultGroupLayout = (): GroupLayoutState => ({
  fileTree: { opened: true, width: 344 },
})

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
}

export type PaneContent = {
  type: TabType
  directory: string
  title?: string
  command?: string
  sessionId?: string
  terminalId?: string
  filePath?: string
  pageId?: string
  reviewMode?: ReviewMode
  reviewFromRef?: string
  reviewToRef?: string
  intent?: {
    name?: string
    role?: string
    refs?: string[]
    defaults?: {
      agent?: string
      system?: string
    }
    meta?: Record<string, string>
  }
}

export type PaneLayout = {
  id: string
  name: string
  icon?: string
  pane: Pane
  contents: Record<string, PaneContent>
  focus?: string
  zoom?: string
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
