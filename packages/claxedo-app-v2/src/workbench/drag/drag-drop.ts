import type { Edge } from "../types"

export function computeDropEdge(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): Edge {
  const fx = (clientX - rect.left) / rect.width
  const fy = (clientY - rect.top) / rect.height
  const distances: readonly [Edge, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ]
  let best = distances[0]
  for (const candidate of distances) if (candidate[1] < best[1]) best = candidate
  return best[0]
}

export type DropTarget = { paneId: string; edge: Edge }

export function hitTestPaneAt(x: number, y: number, within?: HTMLElement): DropTarget | null {
  if (typeof document === "undefined") return null
  const hit = document.elementFromPoint(x, y)
  if (within && !within.contains(hit)) return null
  let el: HTMLElement | null = hit instanceof HTMLElement ? hit : (hit?.parentElement ?? null)
  while (el && !el.dataset.paneId) el = el.parentElement
  const paneId = el?.dataset.paneId
  if (!el || !paneId) return null
  const rect = el.getBoundingClientRect()
  return { paneId, edge: computeDropEdge(rect, x, y) }
}
