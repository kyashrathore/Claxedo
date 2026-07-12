import type { Pane, SplitNode, SplitTree, Edge } from "../types"

let _id = 0
export function nextPaneId(): string {
  // Counter-based for stability inside a single test run; mix in random for cross-instance uniqueness.
  _id += 1
  return `p_${_id}_${Math.random().toString(36).slice(2, 7)}`
}

/** Trim a tree to only contain leaves whose paneIds are present in `paneIds`. */
export function validRoot(node: SplitNode | undefined, paneIds: ReadonlySet<string>): SplitNode | undefined {
  if (!node) return undefined
  const seen = new Set<string>()
  const walk = (n: SplitNode): SplitNode | undefined => {
    if (n.t === "leaf") {
      if (!paneIds.has(n.id) || seen.has(n.id)) return undefined
      seen.add(n.id)
      return n
    }
    const a = walk(n.a)
    const b = walk(n.b)
    if (!a) return b
    if (!b) return a
    const size = clampSize(n.size)
    if (a === n.a && b === n.b && size === n.size) return n
    return { t: "split", dir: n.dir, a, b, size }
  }
  return walk(node)
}

function clampSize(s: number): number {
  if (!Number.isFinite(s)) return 0.5
  return Math.min(1, Math.max(0, s))
}

/** Replace a leaf with `paneId` by `next` subtree. */
export function replaceLeaf(node: SplitNode, paneId: string, next: SplitNode): SplitNode {
  if (node.t === "leaf") {
    return node.id === paneId ? next : node
  }
  const a = replaceLeaf(node.a, paneId, next)
  const b = replaceLeaf(node.b, paneId, next)
  if (a === node.a && b === node.b) return node
  return { t: "split", dir: node.dir, a, b, size: node.size }
}

/** Remove a leaf with `paneId`; collapses parent splits. */
export function removeLeaf(node: SplitNode, paneId: string): SplitNode | undefined {
  if (node.t === "leaf") return node.id === paneId ? undefined : node
  const a = removeLeaf(node.a, paneId)
  const b = removeLeaf(node.b, paneId)
  if (!a) return b
  if (!b) return a
  if (a === node.a && b === node.b) return node
  return { t: "split", dir: node.dir, a, b, size: node.size }
}

/** Append a new leaf next to a target leaf via a split. */
export function splitAt(
  root: SplitNode,
  targetPaneId: string,
  edge: Edge,
  newPaneId: string,
): SplitNode {
  const dir: "h" | "v" = edge === "left" || edge === "right" ? "h" : "v"
  const insertBefore = edge === "left" || edge === "top"
  const target: SplitNode = { t: "leaf", id: targetPaneId }
  const fresh: SplitNode = { t: "leaf", id: newPaneId }
  const node: SplitNode = {
    t: "split",
    dir,
    a: insertBefore ? fresh : target,
    b: insertBefore ? target : fresh,
    size: 0.5,
  }
  return replaceLeaf(root, targetPaneId, node)
}

/** Walk to a node by path of "a"/"b" steps. Returns undefined if path is invalid. */
export function nodeAtPath(
  root: SplitNode | undefined,
  path: ReadonlyArray<"a" | "b">,
): SplitNode | undefined {
  let n: SplitNode | undefined = root
  for (const step of path) {
    if (!n || n.t !== "split") return undefined
    n = step === "a" ? n.a : n.b
  }
  return n
}

/** Set the size of a split node at a given path. Returns new tree, or undefined if path invalid. */
export function setSizeAtPath(
  root: SplitNode | undefined,
  path: ReadonlyArray<"a" | "b">,
  size: number,
): SplitNode | undefined {
  if (!root) return undefined
  const target = nodeAtPath(root, path)
  if (!target || target.t !== "split") return undefined
  const clamped = clampSize(size)
  const apply = (node: SplitNode, depth: number): SplitNode => {
    if (depth === path.length) {
      if (node.t !== "split") return node
      return { ...node, size: clamped }
    }
    if (node.t !== "split") return node
    const step = path[depth]
    if (step === "a") {
      const a = apply(node.a, depth + 1)
      return { ...node, a }
    } else {
      const b = apply(node.b, depth + 1)
      return { ...node, b }
    }
  }
  return apply(root, 0)
}

/** Append a leaf to the end of the tree at the root level (right/bottom). */
export function appendLeafAtRoot(
  root: SplitNode | undefined,
  newPaneId: string,
  direction: "h" | "v",
): SplitNode {
  const fresh: SplitNode = { t: "leaf", id: newPaneId }
  if (!root) return fresh
  return {
    t: "split",
    dir: direction,
    a: root,
    b: fresh,
    size: 0.5,
  }
}

/** Compute fractional rects for every pane in the tree; result is a map paneId → rect. */
export function computePaneRects(
  root: SplitNode | undefined,
): Map<string, { top: number; left: number; width: number; height: number }> {
  const out = new Map<string, { top: number; left: number; width: number; height: number }>()
  if (!root) return out
  const walk = (n: SplitNode, top: number, left: number, w: number, h: number) => {
    if (n.t === "leaf") {
      out.set(n.id, { top, left, width: w, height: h })
      return
    }
    const s = clampSize(n.size)
    if (n.dir === "h") {
      walk(n.a, top, left, w * s, h)
      walk(n.b, top, left + w * s, w * (1 - s), h)
    } else {
      walk(n.a, top, left, w, h * s)
      walk(n.b, top + h * s, left, w, h * (1 - s))
    }
  }
  walk(root, 0, 0, 1, 1)
  return out
}

/** Collect leaf pane ids in render order (left-right, top-bottom traversal). */
export function leafIdsInOrder(root: SplitNode | undefined): string[] {
  if (!root) return []
  const out: string[] = []
  const walk = (n: SplitNode) => {
    if (n.t === "leaf") {
      out.push(n.id)
      return
    }
    walk(n.a)
    walk(n.b)
  }
  walk(root)
  return out
}

/** Build a SplitTree from the given root, deriving sizes from the top-level split. */
export function makeSplitTree(root: SplitNode | undefined): SplitTree {
  if (!root) return { direction: "h", sizes: [], root: undefined }
  if (root.t === "leaf") return { direction: "h", sizes: [1], root }
  return { direction: root.dir, sizes: [root.size, 1 - root.size], root }
}

export type { SplitNode, SplitTree, Pane, Edge }
