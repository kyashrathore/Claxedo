import { constructWorkbenchState } from "./construct"
import type { Pane, Snapshot, SplitNode, SplitTree, WorkbenchState } from "./types"
import { validRoot, makeSplitTree } from "./reducers/tree-helpers"
import { snapshotIsValid } from "./reducers/snapshot-helpers"

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

function validateSplitNode(node: unknown): SplitNode | undefined {
  if (!isObject(node)) return undefined
  if (node.t === "leaf") {
    if (typeof node.id !== "string") return undefined
    return { t: "leaf", id: node.id }
  }
  if (node.t === "split") {
    const dir = node.dir === "h" || node.dir === "v" ? node.dir : undefined
    if (!dir) return undefined
    const a = validateSplitNode(node.a)
    const b = validateSplitNode(node.b)
    if (!a || !b) return undefined
    const size =
      typeof node.size === "number" && Number.isFinite(node.size)
        ? Math.min(1, Math.max(0, node.size))
        : 0.5
    return { t: "split", dir, a, b, size }
  }
  return undefined
}

function validateSplitTree(input: unknown): SplitTree {
  if (!isObject(input)) return { direction: "h", sizes: [], root: undefined }
  const direction = input.direction === "v" ? "v" : "h"
  const sizes = Array.isArray(input.sizes) ? input.sizes.filter((n: unknown) => typeof n === "number") : []
  const root = validateSplitNode(input.root)
  return { direction, sizes, root }
}

function validatePane(input: unknown): Pane | undefined {
  if (!isObject(input)) return undefined
  if (typeof input.id !== "string") return undefined
  const contentId = typeof input.contentId === "string" ? input.contentId : null
  return { id: input.id, contentId }
}

function validateSnapshot(input: unknown): Snapshot | undefined {
  if (!isObject(input)) return undefined
  const panes = Array.isArray(input.panes)
    ? (input.panes.map(validatePane).filter(Boolean) as Pane[])
    : undefined
  if (!panes) return undefined
  const split = validateSplitTree(input.split)
  const focusedPaneId = typeof input.focusedPaneId === "string" ? input.focusedPaneId : null
  return { panes, split, focusedPaneId }
}

export function validate(input: unknown): { state: WorkbenchState; dirty: boolean } {
  if (!isObject(input)) {
    return { state: constructWorkbenchState.empty(), dirty: true }
  }

  let dirty = false

  // Panes.
  const rawPanes = Array.isArray(input.panes) ? input.panes : []
  const panes: Pane[] = []
  for (const p of rawPanes) {
    const v = validatePane(p)
    if (v) panes.push(v)
    else dirty = true
  }

  // contentIds.
  const contentIds: string[] = Array.isArray(input.contentIds)
    ? input.contentIds.filter((id: unknown): id is string => typeof id === "string")
    : []
  if (!Array.isArray(input.contentIds)) dirty = true
  else if (contentIds.length !== input.contentIds.length) dirty = true

  const contentSet = new Set(contentIds)

  // Drop pane.contentId refs that aren't in contentIds.
  for (const p of panes) {
    if (p.contentId !== null && !contentSet.has(p.contentId)) {
      p.contentId = null
      dirty = true
    }
  }

  // Split tree.
  const splitInput = validateSplitTree(input.split)
  const paneIdSet = new Set(panes.map((p) => p.id))
  const trimmedRoot = validRoot(splitInput.root, paneIdSet)
  if (trimmedRoot !== splitInput.root) dirty = true
  const split = makeSplitTree(trimmedRoot)
  // Preserve direction if not implied by a split-root.
  if (!trimmedRoot) split.direction = splitInput.direction

  // contentRecency: drop unknown ids, dedup.
  const recencyRaw = Array.isArray(input.contentRecency)
    ? input.contentRecency.filter((id: unknown): id is string => typeof id === "string")
    : []
  if (!Array.isArray(input.contentRecency)) dirty = true
  const seen = new Set<string>()
  const contentRecency: string[] = []
  for (const id of recencyRaw) {
    if (!contentSet.has(id) || seen.has(id)) {
      dirty = true
      continue
    }
    seen.add(id)
    contentRecency.push(id)
  }
  // Add any missing alive ids to the back of recency.
  for (const id of contentIds) {
    if (!seen.has(id)) {
      seen.add(id)
      contentRecency.push(id)
      dirty = true
    }
  }

  // focusedPaneId.
  let focusedPaneId: string | null = null
  if (typeof input.focusedPaneId === "string") {
    if (paneIdSet.has(input.focusedPaneId)) {
      focusedPaneId = input.focusedPaneId
    } else {
      // Drop and pick first pane if any.
      focusedPaneId = panes[0]?.id ?? null
      dirty = true
    }
  } else {
    focusedPaneId = panes[0]?.id ?? null
    if (input.focusedPaneId !== null && input.focusedPaneId !== undefined) dirty = true
    else if (input.focusedPaneId === undefined) dirty = true
  }
  // If panes became empty because of trimming, focused must be null.
  if (panes.length === 0 && focusedPaneId !== null) {
    focusedPaneId = null
    dirty = true
  }

  // Snapshots.
  const snapshotsInput = isObject(input.layoutSnapshots) ? input.layoutSnapshots : undefined
  const layoutSnapshots: Record<string, Snapshot> = {}
  if (snapshotsInput) {
    for (const [key, val] of Object.entries(snapshotsInput)) {
      if (!contentSet.has(key)) {
        dirty = true
        continue
      }
      const snap = validateSnapshot(val)
      if (!snap) {
        dirty = true
        continue
      }
      if (!snapshotIsValid(snap, contentSet)) {
        dirty = true
        continue
      }
      layoutSnapshots[key] = snap
    }
  } else {
    if (input.layoutSnapshots !== undefined) dirty = true
    else dirty = true
  }

  const state: WorkbenchState = {
    panes,
    split,
    contentIds,
    contentRecency,
    focusedPaneId,
    layoutSnapshots,
  }

  return { state, dirty }
}
