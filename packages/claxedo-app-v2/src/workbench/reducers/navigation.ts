import type { Pane, SplitNode, WorkbenchState } from "../types"
import { saveSnapshotsForCurrentLayout, snapshotIsValid } from "./snapshot-helpers"
import { cloneRoot, nextPaneId } from "./tree-helpers"

function bumpRecency(state: WorkbenchState, contentId: string): string[] {
  return [contentId, ...state.contentRecency.filter((id) => id !== contentId)]
}

function restoreSnapshot(state: WorkbenchState, contentId: string, snapshots: WorkbenchState["layoutSnapshots"]): WorkbenchState {
  const saved = snapshots[contentId]
  const focusPane = saved.panes.find((p) => p.contentId === contentId)
  return {
    ...state,
    panes: saved.panes.map((p) => ({ id: p.id, contentId: p.contentId })),
    split: {
      direction: saved.split.direction,
      sizes: [...saved.split.sizes],
      root: saved.split.root ? cloneRoot(saved.split.root) : undefined,
    },
    focusedPaneId: focusPane?.id ?? saved.focusedPaneId ?? null,
    contentRecency: bumpRecency(state, contentId),
    layoutSnapshots: snapshots,
  }
}

export function show(state: WorkbenchState, contentId: string): WorkbenchState {
  if (!state.contentIds.includes(contentId)) return state
  const focusedPane = state.panes.find((p) => p.id === state.focusedPaneId)
  if (focusedPane && focusedPane.contentId === contentId) return state
  const paneWithContent = state.panes.find((p) => p.contentId === contentId)
  if (paneWithContent) {
    return { ...state, focusedPaneId: paneWithContent.id, contentRecency: bumpRecency(state, contentId) }
  }
  const snapshots = state.panes.length >= 2 ? saveSnapshotsForCurrentLayout(state) : state.layoutSnapshots
  const saved = snapshots[contentId]
  if (saved && snapshotIsValid(saved, new Set(state.contentIds))) return restoreSnapshot(state, contentId, snapshots)
  const paneId = state.panes.length === 1 ? state.panes[0].id : nextPaneId()
  const panes: Pane[] = [{ id: paneId, contentId }]
  const root: SplitNode = { t: "leaf", id: paneId }
  return {
    ...state,
    panes,
    split: { direction: "h", sizes: [1], root },
    focusedPaneId: paneId,
    contentRecency: bumpRecency(state, contentId),
    layoutSnapshots: snapshots,
  }
}
