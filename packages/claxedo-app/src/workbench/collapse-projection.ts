import { isPhoneWidth } from "@/lib/viewport"
import type { PaneRect, WorkbenchState } from "./types"

const FULL_BLEED: PaneRect = { top: 0, left: 0, width: 1, height: 1 }

export function collapsePaneRects(state: WorkbenchState): Map<string, PaneRect> {
  const result = new Map<string, PaneRect>()
  const focused = state.focusedPaneId
  const visiblePaneId = focused != null && state.panes.some((pane) => pane.id === focused) ? focused : state.panes[0]?.id
  if (visiblePaneId == null) return result
  result.set(visiblePaneId, { ...FULL_BLEED })
  return result
}

export function isCollapsedWidth(width: number): boolean {
  return isPhoneWidth(width)
}
