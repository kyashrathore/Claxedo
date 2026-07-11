// Workbench layout types — Phase 1 clean rewrite.

export type Edge = "left" | "right" | "top" | "bottom"

export type Pane = { id: string; contentId: string | null }

export type SplitNode =
  | { t: "leaf"; id: string }
  | { t: "split"; dir: "h" | "v"; a: SplitNode; b: SplitNode; size: number }

export type SplitTree = { direction: "h" | "v"; sizes: number[]; root?: SplitNode }

export type Snapshot = {
  panes: Pane[]
  split: SplitTree
  focusedPaneId: string | null
}

export type WorkbenchState = {
  panes: Pane[]
  split: SplitTree
  contentIds: string[]
  contentRecency: string[]
  focusedPaneId: string | null
  layoutSnapshots: Record<string, Snapshot>
}

export type PaneRect = { top: number; left: number; width: number; height: number }

export type KeyMap = {
  closePane: string
  focusLeft: string
  focusRight: string
  focusUp: string
  focusDown: string
  splitRight: string
  splitDown: string
}

export const WORKBENCH_DRAG_MIME = "application/x-workbench-content"
