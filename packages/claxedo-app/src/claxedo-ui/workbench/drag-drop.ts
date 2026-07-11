import type { Edge } from "./types"

/** Compute the drop edge given a pointer position relative to a pane element. */
export function computeDropEdge(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): Edge {
  const x = clientX - rect.left
  const y = clientY - rect.top
  const fx = x / rect.width
  const fy = y / rect.height
  const distLeft = fx
  const distRight = 1 - fx
  const distTop = fy
  const distBottom = 1 - fy
  const min = Math.min(distLeft, distRight, distTop, distBottom)
  if (min === distLeft) return "left"
  if (min === distRight) return "right"
  if (min === distTop) return "top"
  return "bottom"
}
