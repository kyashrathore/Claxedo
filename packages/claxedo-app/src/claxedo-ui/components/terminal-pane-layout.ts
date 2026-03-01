import type { Pane } from "../context/claxedo-layout"

export function paneLeafIds(pane: Pane): string[] {
  if (pane.t === "leaf") return [pane.id]
  return [...paneLeafIds(pane.a), ...paneLeafIds(pane.b)]
}

export function paneInStore(pane: Pane | undefined, has: (id: string) => boolean) {
  if (!pane) return false
  const ids = paneLeafIds(pane)
  if (ids.length === 0) return false
  return ids.every(has)
}

export type LeafRect = { id: string; top: number; left: number; width: number; height: number }

export type SplitHandle = {
  path: string
  dir: "h" | "v"
  position: number
  top: number
  left: number
  width: number
  height: number
}

export function computeLeafRects(pane: Pane): LeafRect[] {
  const result: LeafRect[] = []
  function walk(node: Pane, top: number, left: number, width: number, height: number) {
    if (node.t === "leaf") {
      result.push({ id: node.id, top, left, width, height })
      return
    }
    if (node.dir === "v") {
      const aWidth = width * node.size
      walk(node.a, top, left, aWidth, height)
      walk(node.b, top, left + aWidth, width - aWidth, height)
      return
    }
    const aHeight = height * node.size
    walk(node.a, top, left, width, aHeight)
    walk(node.b, top + aHeight, left, width, height - aHeight)
  }
  walk(pane, 0, 0, 1, 1)
  return result
}

export function computeSplitHandles(pane: Pane): SplitHandle[] {
  const handles: SplitHandle[] = []
  function walk(node: Pane, top: number, left: number, width: number, height: number, path: string) {
    if (node.t === "leaf") return
    if (node.dir === "v") {
      const splitX = left + width * node.size
      handles.push({ path, dir: "v", position: node.size, top, left: splitX, width: 0, height })
      const aWidth = width * node.size
      walk(node.a, top, left, aWidth, height, path + "a")
      walk(node.b, top, left + aWidth, width - aWidth, height, path + "b")
      return
    }
    const splitY = top + height * node.size
    handles.push({ path, dir: "h", position: node.size, top: splitY, left, width, height: 0 })
    const aHeight = height * node.size
    walk(node.a, top, left, width, aHeight, path + "a")
    walk(node.b, top + aHeight, left, width, height - aHeight, path + "b")
  }
  walk(pane, 0, 0, 1, 1, "")
  return handles
}
