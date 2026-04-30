import type { WorkbenchState } from "../types"
import { invalidateSnapshotsForRemovedContent } from "./snapshot-helpers"

export function add(state: WorkbenchState, contentId: string): WorkbenchState {
  if (state.contentIds.includes(contentId)) return state
  return {
    ...state,
    contentIds: [...state.contentIds, contentId],
    contentRecency: [contentId, ...state.contentRecency.filter((id) => id !== contentId)],
  }
}

export function remove(state: WorkbenchState, contentId: string): WorkbenchState {
  if (!state.contentIds.includes(contentId)) return state
  const panes = state.panes.map((p) => (p.contentId === contentId ? { ...p, contentId: null } : p))
  const layoutSnapshots = invalidateSnapshotsForRemovedContent(state.layoutSnapshots, contentId)
  return {
    ...state,
    panes,
    contentIds: state.contentIds.filter((id) => id !== contentId),
    contentRecency: state.contentRecency.filter((id) => id !== contentId),
    layoutSnapshots,
  }
}
