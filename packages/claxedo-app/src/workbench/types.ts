export type Edge = "left" | "right" | "top" | "bottom"

export const NEW_PANE = "new"

export type MovePaneTarget = string

export type Pane = { id: string; contentId: string | null }

export type SplitDirection = "h" | "v"

export type SplitNode =
  | { t: "leaf"; id: string }
  | { t: "split"; dir: SplitDirection; a: SplitNode; b: SplitNode; size: number }

export type SplitPath = ReadonlyArray<"a" | "b">

export type SplitTree = { direction: SplitDirection; sizes: number[]; root?: SplitNode }

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
