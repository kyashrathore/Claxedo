import type { Snapshot, WorkbenchState } from "../types"

/** Drop snapshots keyed by removed content AND any snapshot that references it. */
export function invalidateSnapshotsForRemovedContent(
  snapshots: Record<string, Snapshot>,
  removedContentId: string,
): Record<string, Snapshot> {
  const out: Record<string, Snapshot> = {}
  for (const [key, snap] of Object.entries(snapshots)) {
    if (key === removedContentId) continue
    const refsRemoved = snap.panes.some((p) => p.contentId === removedContentId)
    if (refsRemoved) continue
    out[key] = snap
  }
  return out
}

/** Save snapshots for every visible content id when there are 2+ visible panes. */
export function saveSnapshotsForCurrentLayout(state: WorkbenchState): Record<string, Snapshot> {
  if (state.panes.length < 2) return state.layoutSnapshots
  const snap: Snapshot = {
    panes: state.panes.map((p) => ({ id: p.id, contentId: p.contentId })),
    split: {
      direction: state.split.direction,
      sizes: [...state.split.sizes],
      root: state.split.root ? cloneSplitRoot(state.split.root) : undefined,
    },
    focusedPaneId: state.focusedPaneId,
  }
  const next: Record<string, Snapshot> = { ...state.layoutSnapshots }
  for (const pane of state.panes) {
    if (pane.contentId) next[pane.contentId] = snap
  }
  return next
}

function cloneSplitRoot(node: any): any {
  if (node.t === "leaf") return { t: "leaf", id: node.id }
  return {
    t: "split",
    dir: node.dir,
    a: cloneSplitRoot(node.a),
    b: cloneSplitRoot(node.b),
    size: node.size,
  }
}

/** Returns true if every content id referenced in the snapshot's panes is in `contentIds`. */
export function snapshotIsValid(snap: Snapshot, contentIds: ReadonlySet<string>): boolean {
  for (const p of snap.panes) {
    if (p.contentId && !contentIds.has(p.contentId)) return false
  }
  return true
}
