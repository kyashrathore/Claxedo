import type { Edge, Pane, SplitNode, WorkbenchState } from "../types"
import {
  appendLeafAtRoot,
  leafIdsInOrder,
  makeSplitTree,
  nextPaneId,
  nodeAtPath,
  removeLeaf,
  replaceLeaf,
  setSizeAtPath,
  splitAt,
  validRoot,
} from "./tree-helpers"
import * as contents from "./contents"
import { invalidateSnapshotsForRemovedContent } from "./snapshot-helpers"

/**
 * split.split — adds a new pane next to the target on the requested edge.
 * - Self-drop (same pane currently holds contentId) is a no-op.
 * - If contentId is held by a different pane, that pane is unbound (the content "moves").
 * - If contentId is not in contentIds, it's implicitly added.
 */
export function split(
  state: WorkbenchState,
  targetPaneId: string,
  edge: Edge,
  contentId: string,
): WorkbenchState {
  const target = state.panes.find((p) => p.id === targetPaneId)
  if (!target) return state

  // Self-drop guard.
  if (target.contentId === contentId) return state

  // Implicit add if missing.
  let next: WorkbenchState = state.contentIds.includes(contentId)
    ? state
    : contents.add(state, contentId)

  // Unbind any other pane currently holding this content.
  const panes = next.panes.map((p) =>
    p.id !== targetPaneId && p.contentId === contentId ? { ...p, contentId: null } : p,
  )

  // Make a new pane.
  const newPaneId = nextPaneId()
  const newPanesList: Pane[] = [...panes, { id: newPaneId, contentId }]

  // Bump recency for the inserted content.
  const newRecency = [contentId, ...next.contentRecency.filter((id) => id !== contentId)]

  // Build the new tree.
  let root: SplitNode | undefined = next.split.root
  if (!root) {
    // Single-pane → make a split root.
    const dir: "h" | "v" = edge === "left" || edge === "right" ? "h" : "v"
    const insertBefore = edge === "left" || edge === "top"
    root = {
      t: "split",
      dir,
      a: insertBefore ? { t: "leaf", id: newPaneId } : { t: "leaf", id: targetPaneId },
      b: insertBefore ? { t: "leaf", id: targetPaneId } : { t: "leaf", id: newPaneId },
      size: 0.5,
    }
  } else {
    root = splitAt(root, targetPaneId, edge, newPaneId)
  }

  return {
    ...next,
    panes: newPanesList,
    contentRecency: newRecency,
    split: makeSplitTree(root),
    focusedPaneId: newPaneId,
  }
}

/**
 * split.close — closes a pane.
 * destroyContent:true removes the content from the registry too.
 */
export function close(
  state: WorkbenchState,
  paneId: string,
  opts: { destroyContent: boolean },
): WorkbenchState {
  const pane = state.panes.find((p) => p.id === paneId)
  if (!pane) return state

  const closedContentId = pane.contentId
  const destroyedContentId = opts.destroyContent ? closedContentId : null

  // Compute remaining panes.
  const remainingPanes = state.panes.filter((p) => p.id !== paneId)

  // Compute remaining tree.
  const newRootRaw = state.split.root ? removeLeaf(state.split.root, paneId) : undefined
  const remainingPaneIds = new Set(remainingPanes.map((p) => p.id))
  let newRoot = validRoot(newRootRaw, remainingPaneIds)
  // If the tree is empty but we still have panes (orphans?), build a fresh leaf for each.
  if (!newRoot && remainingPanes.length > 0) {
    // Build a degenerate tree from remaining panes (rare; happens if previous tree was malformed).
    let r: SplitNode | undefined = undefined
    for (const p of remainingPanes) {
      r = appendLeafAtRoot(r, p.id, "h")
    }
    newRoot = r
  }

  const newSplit = makeSplitTree(newRoot)

  // Choose new focus: most-recent surviving pane.
  let nextFocused: string | null = state.focusedPaneId
  if (state.focusedPaneId === paneId || !remainingPaneIds.has(state.focusedPaneId ?? "")) {
    if (remainingPanes.length === 0) {
      nextFocused = null
    } else {
      // Find most-recent content among surviving panes.
      const recencySet = new Map<string, number>()
      state.contentRecency.forEach((id, i) => recencySet.set(id, i))
      let best: Pane | undefined
      let bestRank = Infinity
      for (const p of remainingPanes) {
        if (!p.contentId) continue
        const r = recencySet.get(p.contentId)
        if (r !== undefined && r < bestRank) {
          bestRank = r
          best = p
        }
      }
      nextFocused = (best ?? remainingPanes[0]).id
    }
  }

  let next: WorkbenchState = {
    ...state,
    panes: remainingPanes,
    split: newSplit,
    focusedPaneId: nextFocused,
  }

  if (closedContentId) {
    next = {
      ...next,
      layoutSnapshots: invalidateSnapshotsForRemovedContent(next.layoutSnapshots, closedContentId),
    }
  }

  if (destroyedContentId) {
    next = contents.remove(next, destroyedContentId)
  }

  return next
}

/**
 * split.move — move content from one pane to another (or to a new pane).
 */
export function move(
  state: WorkbenchState,
  contentId: string,
  fromPaneId: string,
  toPaneId: string | "new",
): WorkbenchState {
  const fromIdx = state.panes.findIndex((p) => p.id === fromPaneId)
  if (fromIdx === -1) return state
  if (state.panes[fromIdx].contentId !== contentId) return state

  if (toPaneId === "new") {
    const newPaneId = nextPaneId()
    const panes: Pane[] = [
      ...state.panes.map((p, i) => (i === fromIdx ? { ...p, contentId: null } : p)),
      { id: newPaneId, contentId },
    ]
    const root = state.split.root
      ? appendLeafAtRoot(state.split.root, newPaneId, state.split.direction || "h")
      : ({ t: "leaf", id: newPaneId } as SplitNode)
    return {
      ...state,
      panes,
      split: makeSplitTree(root),
      focusedPaneId: newPaneId,
    }
  }

  const toIdx = state.panes.findIndex((p) => p.id === toPaneId)
  if (toIdx === -1) return state
  const panes = state.panes.map((p, i) => {
    if (i === fromIdx) return { ...p, contentId: null }
    if (i === toIdx) return { ...p, contentId }
    return p
  })
  return { ...state, panes, focusedPaneId: toPaneId }
}

/**
 * split.focus — set the focused pane and bump its content's recency.
 */
export function focus(state: WorkbenchState, paneId: string): WorkbenchState {
  const pane = state.panes.find((p) => p.id === paneId)
  if (!pane) return state
  if (state.focusedPaneId === paneId && (!pane.contentId || state.contentRecency[0] === pane.contentId)) {
    return state
  }
  let recency = state.contentRecency
  if (pane.contentId) {
    recency = [pane.contentId, ...state.contentRecency.filter((id) => id !== pane.contentId)]
  }
  return { ...state, focusedPaneId: paneId, contentRecency: recency }
}

/**
 * split.resize — set the size of a split node at the given path.
 */
export function resize(
  state: WorkbenchState,
  path: ReadonlyArray<"a" | "b">,
  ratio: number,
): WorkbenchState {
  const target = nodeAtPath(state.split.root, path)
  if (!target || target.t !== "split") return state
  const newRoot = setSizeAtPath(state.split.root, path, ratio)
  if (!newRoot) return state
  // Update top-level sizes if path is empty (root resize).
  let sizes = state.split.sizes
  if (path.length === 0 && newRoot.t === "split") {
    sizes = [newRoot.size, 1 - newRoot.size]
  }
  return { ...state, split: { ...state.split, root: newRoot, sizes } }
}
