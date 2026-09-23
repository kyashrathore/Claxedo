export type Edge = "left" | "right" | "top" | "bottom"

/**
 * Where a `split.move` puts the content: an existing pane's id, or the
 * sentinel `NEW_PANE` asking the reducer to create one.
 *
 * A pane id is a string, so `string | "new"` collapsed to `string` and only
 * looked like a union. The sentinel is a named constant instead.
 */
export const NEW_PANE = "new"
export type MovePaneTarget = string

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

export { WORKBENCH_DRAG_MIME } from "@/lib/workbench-drag"
