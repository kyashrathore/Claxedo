import type { Edge, MovePaneTarget, Pane, SplitNode, SplitPath, WorkbenchState } from "../types"
import { NEW_PANE } from "../types"
import * as contents from "./contents"
import { invalidateSnapshotsForRemovedContent } from "./snapshot-helpers"
import {
  appendLeafAtRoot,
  makeSplitTree,
  nextPaneId,
  nodeAtPath,
  removeLeaf,
  setSizeAtPath,
  splitAt,
  splitLeaf,
  validRoot,
} from "./tree-helpers"

export function split(state: WorkbenchState, targetPaneId: string, edge: Edge, contentId: string): WorkbenchState {
  const target = state.panes.find((p) => p.id === targetPaneId)
  if (!target) return state
  if (target.contentId === contentId) return state
  const next = state.contentIds.includes(contentId) ? state : contents.add(state, contentId)
  const panes = next.panes.map((p) => (p.id !== targetPaneId && p.contentId === contentId ? { ...p, contentId: null } : p))
  const newPaneId = nextPaneId()
  const root = next.split.root ? splitAt(next.split.root, targetPaneId, edge, newPaneId) : splitLeaf(targetPaneId, edge, newPaneId)
  return {
    ...next,
    panes: [...panes, { id: newPaneId, contentId }],
    contentRecency: [contentId, ...next.contentRecency.filter((id) => id !== contentId)],
    split: makeSplitTree(root),
    focusedPaneId: newPaneId,
  }
}

function mostRecentPane(state: WorkbenchState, panes: readonly Pane[]): Pane {
  const rank = new Map<string, number>()
  state.contentRecency.forEach((id, index) => rank.set(id, index))
  let best: Pane | undefined
  let bestRank = Infinity
  for (const pane of panes) {
    if (!pane.contentId) continue
    const r = rank.get(pane.contentId)
    if (r !== undefined && r < bestRank) {
      bestRank = r
      best = pane
    }
  }
  return best ?? panes[0]
}

function rebuiltRoot(root: SplitNode | undefined, panes: readonly Pane[]): SplitNode | undefined {
  if (root || panes.length === 0) return root
  let rebuilt: SplitNode | undefined
  for (const pane of panes) rebuilt = appendLeafAtRoot(rebuilt, pane.id, "h")
  return rebuilt
}

export function close(state: WorkbenchState, paneId: string, opts: { destroyContent: boolean }): WorkbenchState {
  const pane = state.panes.find((p) => p.id === paneId)
  if (!pane) return state
  const closedContentId = pane.contentId
  const remainingPanes = state.panes.filter((p) => p.id !== paneId)
  const remainingIds = new Set(remainingPanes.map((p) => p.id))
  const trimmed = validRoot(state.split.root ? removeLeaf(state.split.root, paneId) : undefined, remainingIds)
  const newRoot = rebuiltRoot(trimmed, remainingPanes)
  const focusLost = state.focusedPaneId === paneId || !remainingIds.has(state.focusedPaneId ?? "")
  const nextFocused = focusLost ? (remainingPanes.length === 0 ? null : mostRecentPane(state, remainingPanes).id) : state.focusedPaneId
  let next: WorkbenchState = { ...state, panes: remainingPanes, split: makeSplitTree(newRoot), focusedPaneId: nextFocused }
  if (closedContentId) {
    next = { ...next, layoutSnapshots: invalidateSnapshotsForRemovedContent(next.layoutSnapshots, closedContentId) }
  }
  if (opts.destroyContent && closedContentId) next = contents.remove(next, closedContentId)
  return next
}

export function move(state: WorkbenchState, contentId: string, fromPaneId: string, toPaneId: MovePaneTarget): WorkbenchState {
  const fromIndex = state.panes.findIndex((p) => p.id === fromPaneId)
  if (fromIndex === -1) return state
  if (state.panes[fromIndex].contentId !== contentId) return state
  if (toPaneId === NEW_PANE) {
    const newPaneId = nextPaneId()
    const panes: Pane[] = [
      ...state.panes.map((p, i) => (i === fromIndex ? { ...p, contentId: null } : p)),
      { id: newPaneId, contentId },
    ]
    const root = state.split.root
      ? appendLeafAtRoot(state.split.root, newPaneId, state.split.direction || "h")
      : ({ t: "leaf", id: newPaneId } as SplitNode)
    return { ...state, panes, split: makeSplitTree(root), focusedPaneId: newPaneId }
  }
  const toIndex = state.panes.findIndex((p) => p.id === toPaneId)
  if (toIndex === -1) return state
  const panes = state.panes.map((p, i) => {
    if (i === fromIndex) return { ...p, contentId: null }
    if (i === toIndex) return { ...p, contentId }
    return p
  })
  return { ...state, panes, focusedPaneId: toPaneId }
}

export function focus(state: WorkbenchState, paneId: string): WorkbenchState {
  const pane = state.panes.find((p) => p.id === paneId)
  if (!pane) return state
  if (state.focusedPaneId === paneId && (!pane.contentId || state.contentRecency[0] === pane.contentId)) return state
  const contentRecency = pane.contentId
    ? [pane.contentId, ...state.contentRecency.filter((id) => id !== pane.contentId)]
    : state.contentRecency
  return { ...state, focusedPaneId: paneId, contentRecency }
}

export function resize(state: WorkbenchState, path: SplitPath, ratio: number): WorkbenchState {
  const target = nodeAtPath(state.split.root, path)
  if (!target || target.t !== "split") return state
  const newRoot = setSizeAtPath(state.split.root, path, ratio)
  if (!newRoot) return state
  const sizes = path.length === 0 && newRoot.t === "split" ? [newRoot.size, 1 - newRoot.size] : state.split.sizes
  return { ...state, split: { ...state.split, root: newRoot, sizes } }
}
