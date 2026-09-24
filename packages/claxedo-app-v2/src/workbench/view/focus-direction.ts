import { computePaneRects } from "../reducers/tree-helpers"
import type { PaneRect, WorkbenchState } from "../types"

export type FocusDirection = "left" | "right" | "up" | "down"

function score(direction: FocusDirection, from: PaneRect, to: PaneRect): number | undefined {
  const cx = from.left + from.width / 2
  const cy = from.top + from.height / 2
  const rcx = to.left + to.width / 2
  const rcy = to.top + to.height / 2
  switch (direction) {
    case "left":
      return rcx < cx ? cx - rcx + Math.abs(rcy - cy) * 2 : undefined
    case "right":
      return rcx > cx ? rcx - cx + Math.abs(rcy - cy) * 2 : undefined
    case "up":
      return rcy < cy ? cy - rcy + Math.abs(rcx - cx) * 2 : undefined
    case "down":
      return rcy > cy ? rcy - cy + Math.abs(rcx - cx) * 2 : undefined
  }
}

export function paneInDirection(state: WorkbenchState, direction: FocusDirection): string | undefined {
  const rects = computePaneRects(state.split.root)
  const focusedId = state.focusedPaneId
  const me = focusedId ? rects.get(focusedId) : undefined
  if (!me) return undefined
  let best: { id: string; score: number } | undefined
  for (const [paneId, rect] of rects) {
    if (paneId === focusedId) continue
    const candidate = score(direction, me, rect)
    if (candidate === undefined) continue
    if (!best || candidate < best.score) best = { id: paneId, score: candidate }
  }
  return best?.id
}
