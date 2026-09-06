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

/** The pane and edge a pointer drag would drop onto. */
export type DropTarget = { paneId: string; edge: Edge }

/**
 * Find the pane under a pointer position and the edge it would split on.
 * `elementFromPoint` finds the pane under the cursor; the drag ghost is
 * `pointer-events:none` so it never occludes it.
 */
export function hitTestPaneAt(x: number, y: number): DropTarget | null {
  if (typeof document === "undefined" || !document.elementFromPoint) return null
  const hit = document.elementFromPoint(x, y)
  // `elementFromPoint` yields an Element (an SVG glyph inside a pane, say);
  // walk to the first HTML ancestor and from there up to the pane node.
  let el: HTMLElement | null = hit instanceof HTMLElement ? hit : (hit?.parentElement ?? null)
  while (el && !el.dataset.paneId) el = el.parentElement
  const paneId = el?.dataset.paneId
  if (!el || !paneId) return null
  const rect = el.getBoundingClientRect()
  const edge = computeDropEdge({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, x, y)
  return { paneId, edge }
}
