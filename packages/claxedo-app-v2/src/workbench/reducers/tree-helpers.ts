import type { Edge, PaneRect, SplitDirection, SplitNode, SplitPath, SplitTree } from "../types"

export function nextPaneId(): string {
  return `p_${Math.random().toString(36).slice(2, 10)}`
}

export function clampSize(size: number): number {
  if (!Number.isFinite(size)) return 0.5
  return Math.min(1, Math.max(0, size))
}

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

export function replaceLeaf(node: SplitNode, paneId: string, next: SplitNode): SplitNode {
  if (node.t === "leaf") return node.id === paneId ? next : node
  const a = replaceLeaf(node.a, paneId, next)
  const b = replaceLeaf(node.b, paneId, next)
  if (a === node.a && b === node.b) return node
  return { t: "split", dir: node.dir, a, b, size: node.size }
}

export function removeLeaf(node: SplitNode, paneId: string): SplitNode | undefined {
  if (node.t === "leaf") return node.id === paneId ? undefined : node
  const a = removeLeaf(node.a, paneId)
  const b = removeLeaf(node.b, paneId)
  if (!a) return b
  if (!b) return a
  if (a === node.a && b === node.b) return node
  return { t: "split", dir: node.dir, a, b, size: node.size }
}

export function splitLeaf(targetPaneId: string, edge: Edge, newPaneId: string): SplitNode {
  const dir: SplitDirection = edge === "left" || edge === "right" ? "h" : "v"
  const insertBefore = edge === "left" || edge === "top"
  const target: SplitNode = { t: "leaf", id: targetPaneId }
  const fresh: SplitNode = { t: "leaf", id: newPaneId }
  return { t: "split", dir, a: insertBefore ? fresh : target, b: insertBefore ? target : fresh, size: 0.5 }
}

export function splitAt(root: SplitNode, targetPaneId: string, edge: Edge, newPaneId: string): SplitNode {
  return replaceLeaf(root, targetPaneId, splitLeaf(targetPaneId, edge, newPaneId))
}

export function nodeAtPath(root: SplitNode | undefined, path: SplitPath): SplitNode | undefined {
  let node: SplitNode | undefined = root
  for (const step of path) {
    if (!node || node.t !== "split") return undefined
    node = step === "a" ? node.a : node.b
  }
  return node
}

export function setSizeAtPath(root: SplitNode | undefined, path: SplitPath, size: number): SplitNode | undefined {
  if (!root) return undefined
  const target = nodeAtPath(root, path)
  if (!target || target.t !== "split") return undefined
  const clamped = clampSize(size)
  const apply = (node: SplitNode, depth: number): SplitNode => {
    if (node.t !== "split") return node
    if (depth === path.length) return { ...node, size: clamped }
    return path[depth] === "a" ? { ...node, a: apply(node.a, depth + 1) } : { ...node, b: apply(node.b, depth + 1) }
  }
  return apply(root, 0)
}

export function appendLeafAtRoot(root: SplitNode | undefined, newPaneId: string, direction: SplitDirection): SplitNode {
  const fresh: SplitNode = { t: "leaf", id: newPaneId }
  if (!root) return fresh
  return { t: "split", dir: direction, a: root, b: fresh, size: 0.5 }
}

export function computePaneRects(root: SplitNode | undefined): Map<string, PaneRect> {
  const out = new Map<string, PaneRect>()
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

export function makeSplitTree(root: SplitNode | undefined): SplitTree {
  if (!root) return { direction: "h", sizes: [], root: undefined }
  if (root.t === "leaf") return { direction: "h", sizes: [1], root }
  return { direction: root.dir, sizes: [root.size, 1 - root.size], root }
}

export function cloneRoot(node: SplitNode): SplitNode {
  if (node.t === "leaf") return { t: "leaf", id: node.id }
  return { t: "split", dir: node.dir, a: cloneRoot(node.a), b: cloneRoot(node.b), size: node.size }
}
