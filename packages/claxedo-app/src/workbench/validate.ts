import { isRecord } from "@claxedo/helpers/guards"
import { constructWorkbenchState } from "./construct"
import type { Pane, Snapshot, SplitNode, SplitTree, WorkbenchState } from "./types"
import { snapshotIsValid } from "./reducers/snapshot-helpers"
import { clampSize, makeSplitTree, validRoot } from "./reducers/tree-helpers"

function validateSplitNode(node: unknown): SplitNode | undefined {
  if (!isRecord(node)) return undefined
  if (node.t === "leaf") return typeof node.id === "string" ? { t: "leaf", id: node.id } : undefined
  if (node.t !== "split") return undefined
  const dir = node.dir === "h" || node.dir === "v" ? node.dir : undefined
  if (!dir) return undefined
  const a = validateSplitNode(node.a)
  const b = validateSplitNode(node.b)
  if (!a || !b) return undefined
  const size = typeof node.size === "number" ? clampSize(node.size) : 0.5
  return { t: "split", dir, a, b, size }
}

function validateSplitTree(input: unknown): SplitTree {
  if (!isRecord(input)) return { direction: "h", sizes: [], root: undefined }
  const direction = input.direction === "v" ? "v" : "h"
  const sizes = Array.isArray(input.sizes) ? input.sizes.filter((n: unknown): n is number => typeof n === "number") : []
  return { direction, sizes, root: validateSplitNode(input.root) }
}

function validatePane(input: unknown): Pane | undefined {
  if (!isRecord(input) || typeof input.id !== "string") return undefined
  return { id: input.id, contentId: typeof input.contentId === "string" ? input.contentId : null }
}

function validatePanes(input: unknown): Pane[] {
  if (!Array.isArray(input)) return []
  return input.map(validatePane).filter((pane): pane is Pane => pane !== undefined)
}

function validateStrings(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.filter((id: unknown): id is string => typeof id === "string")
}

function validateSnapshot(input: unknown, contentIds: ReadonlySet<string>): Snapshot | undefined {
  if (!isRecord(input) || !Array.isArray(input.panes)) return undefined
  const snapshot: Snapshot = {
    panes: validatePanes(input.panes),
    split: validateSplitTree(input.split),
    focusedPaneId: typeof input.focusedPaneId === "string" ? input.focusedPaneId : null,
  }
  return snapshotIsValid(snapshot, contentIds) ? snapshot : undefined
}

function validateSnapshots(input: unknown, contentIds: ReadonlySet<string>): Record<string, Snapshot> {
  const out: Record<string, Snapshot> = {}
  if (!isRecord(input)) return out
  for (const [key, value] of Object.entries(input)) {
    if (!contentIds.has(key)) continue
    const snapshot = validateSnapshot(value, contentIds)
    if (snapshot) out[key] = snapshot
  }
  return out
}

function validateRecency(input: unknown, contentIds: readonly string[]): string[] {
  const contentSet = new Set(contentIds)
  const seen = new Set<string>()
  const recency: string[] = []
  for (const id of [...validateStrings(input), ...contentIds]) {
    if (!contentSet.has(id) || seen.has(id)) continue
    seen.add(id)
    recency.push(id)
  }
  return recency
}

export function validate(input: unknown): WorkbenchState {
  if (!isRecord(input)) return constructWorkbenchState.empty()
  const contentIds = validateStrings(input.contentIds)
  const contentSet = new Set(contentIds)
  const panes = validatePanes(input.panes).map((pane) =>
    pane.contentId !== null && !contentSet.has(pane.contentId) ? { ...pane, contentId: null } : pane,
  )
  const paneIds = new Set(panes.map((p) => p.id))
  const splitInput = validateSplitTree(input.split)
  const trimmedRoot = validRoot(splitInput.root, paneIds)
  const split = makeSplitTree(trimmedRoot)
  if (!trimmedRoot) split.direction = splitInput.direction
  const focusedInput = typeof input.focusedPaneId === "string" ? input.focusedPaneId : undefined
  const focusedPaneId = focusedInput && paneIds.has(focusedInput) ? focusedInput : (panes[0]?.id ?? null)
  return {
    panes,
    split,
    contentIds,
    contentRecency: validateRecency(input.contentRecency, contentIds),
    focusedPaneId,
    layoutSnapshots: validateSnapshots(input.layoutSnapshots, contentSet),
  }
}
