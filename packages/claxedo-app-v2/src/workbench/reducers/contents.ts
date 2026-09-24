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

export function reorder(state: WorkbenchState, contentId: string, index: number): WorkbenchState {
  const from = state.contentIds.indexOf(contentId)
  if (from < 0) return state
  const to = Math.max(0, Math.min(Math.trunc(index), state.contentIds.length - 1))
  if (from === to) return state
  const contentIds = state.contentIds.filter((id) => id !== contentId)
  contentIds.splice(to, 0, contentId)
  return { ...state, contentIds }
}
