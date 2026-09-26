import type { Snapshot, WorkbenchState } from "../types"
import { cloneRoot } from "./tree-helpers"

export function invalidateSnapshotsForRemovedContent(
  snapshots: Record<string, Snapshot>,
  removedContentId: string,
): Record<string, Snapshot> {
  const out: Record<string, Snapshot> = {}
  for (const [key, snap] of Object.entries(snapshots)) {
    if (key === removedContentId) continue
    if (snap.panes.some((p) => p.contentId === removedContentId)) continue
    out[key] = snap
  }
  return out
}

export function saveSnapshotsForCurrentLayout(state: WorkbenchState): Record<string, Snapshot> {
  if (state.panes.length < 2) return state.layoutSnapshots
  const snap: Snapshot = {
    panes: state.panes.map((p) => ({ id: p.id, contentId: p.contentId })),
    split: {
      direction: state.split.direction,
      sizes: [...state.split.sizes],
      root: state.split.root ? cloneRoot(state.split.root) : undefined,
    },
    focusedPaneId: state.focusedPaneId,
  }
  const next: Record<string, Snapshot> = { ...state.layoutSnapshots }
  for (const pane of state.panes) {
    if (pane.contentId) next[pane.contentId] = snap
  }
  return next
}

export function snapshotIsValid(snap: Snapshot, contentIds: ReadonlySet<string>): boolean {
  return snap.panes.every((p) => !p.contentId || contentIds.has(p.contentId))
}
