import type { Pane, PaneRect, Snapshot, WorkbenchState } from "./types"
import { computePaneRects } from "./reducers/tree-helpers"

export const selectors = {
  aliveContents(state: WorkbenchState): readonly string[] {
    return state.contentIds
  },

  recentContents(state: WorkbenchState): readonly string[] {
    return state.contentRecency
  },

  contentPane(state: WorkbenchState, contentId: string): string | null {
    const pane = state.panes.find((p) => p.contentId === contentId)
    return pane?.id ?? null
  },

  visiblePanes(state: WorkbenchState): readonly Pane[] {
    return state.panes
  },

  paneRect(state: WorkbenchState, paneId: string): PaneRect | undefined {
    const rects = computePaneRects(state.split.root)
    return rects.get(paneId)
  },

  focusedContent(state: WorkbenchState): string | null {
    if (!state.focusedPaneId) return null
    const pane = state.panes.find((p) => p.id === state.focusedPaneId)
    return pane?.contentId ?? null
  },

  /**
   * The most-recently-used alive content that is not currently bound to any
   * pane (a background/switcher surface), excluding the focused content. This
   * is the surface a keyboard split (mod+\) reveals beside the focused pane —
   * the model holds one content per pane, so a split brings a hidden surface
   * into view rather than duplicating the focused one. Returns null when there
   * is nothing hidden to reveal.
   */
  mruHiddenContent(state: WorkbenchState): string | null {
    const bound = new Set(state.panes.map((p) => p.contentId).filter((id): id is string => !!id))
    const focused = state.focusedPaneId
      ? (state.panes.find((p) => p.id === state.focusedPaneId)?.contentId ?? null)
      : null
    for (const id of state.contentRecency) {
      if (id === focused) continue
      if (!state.contentIds.includes(id)) continue
      if (bound.has(id)) continue
      return id
    }
    return null
  },

  snapshotFor(state: WorkbenchState, contentId: string): Snapshot | undefined {
    return state.layoutSnapshots[contentId]
  },
}
