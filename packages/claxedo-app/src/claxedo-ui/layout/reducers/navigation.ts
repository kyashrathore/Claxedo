import type { Pane, SplitNode, WorkbenchState } from "../types"
import { saveSnapshotsForCurrentLayout, snapshotIsValid } from "./snapshot-helpers"
import { nextPaneId } from "./tree-helpers"

/**
 * navigation.show(X)
 *  - X already in focused pane: no-op.
 *  - X in another pane: focus that pane (and bump recency). No snapshot save.
 *  - From single-pane layout: replace that single pane with X (no snapshot save).
 *  - From 2+ pane layout: save snapshots for currently visible contents, then:
 *     - If X has a valid saved snapshot, restore it.
 *     - Else: collapse to a single new pane displaying X.
 *  - X not in contentIds: no-op.
 */
export function show(state: WorkbenchState, contentId: string): WorkbenchState {
  if (!state.contentIds.includes(contentId)) return state

  // Check focused pane.
  const focusedPane = state.panes.find((p) => p.id === state.focusedPaneId)
  if (focusedPane && focusedPane.contentId === contentId) return state

  // Check if content is in any visible pane.
  const paneWithContent = state.panes.find((p) => p.contentId === contentId)
  if (paneWithContent) {
    // Just focus that pane.
    const recency = [contentId, ...state.contentRecency.filter((id) => id !== contentId)]
    return { ...state, focusedPaneId: paneWithContent.id, contentRecency: recency }
  }

  // Snapshot save (if 2+ panes).
  let snapshots = state.layoutSnapshots
  if (state.panes.length >= 2) {
    snapshots = saveSnapshotsForCurrentLayout(state)
  }

  // Try to restore snapshot for X.
  const contentIdSet = new Set(state.contentIds)
  const saved = snapshots[contentId]
  if (saved && snapshotIsValid(saved, contentIdSet)) {
    // Restore: overwrite panes, split, focusedPaneId.
    const recency = [contentId, ...state.contentRecency.filter((id) => id !== contentId)]
    // Determine focused pane — prefer one holding X.
    const focusPane = saved.panes.find((p) => p.contentId === contentId)
    return {
      ...state,
      panes: saved.panes.map((p) => ({ id: p.id, contentId: p.contentId })),
      split: {
        direction: saved.split.direction,
        sizes: [...saved.split.sizes],
        root: saved.split.root ? cloneRoot(saved.split.root) : undefined,
      },
      focusedPaneId: (focusPane?.id ?? saved.focusedPaneId) ?? null,
      contentRecency: recency,
      layoutSnapshots: snapshots,
    }
  }

  // Single-pane fallback.
  const newPaneId = nextPaneId()
  const recency = [contentId, ...state.contentRecency.filter((id) => id !== contentId)]
  const panes: Pane[] = [{ id: newPaneId, contentId }]
  const root: SplitNode = { t: "leaf", id: newPaneId }
  return {
    ...state,
    panes,
    split: { direction: "h", sizes: [1], root },
    focusedPaneId: newPaneId,
    contentRecency: recency,
    layoutSnapshots: snapshots,
  }
}

function cloneRoot(node: SplitNode): SplitNode {
  if (node.t === "leaf") return { t: "leaf", id: node.id }
  return {
    t: "split",
    dir: node.dir,
    a: cloneRoot(node.a),
    b: cloneRoot(node.b),
    size: node.size,
  }
}
