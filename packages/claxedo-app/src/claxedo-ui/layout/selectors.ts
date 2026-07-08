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

  snapshotFor(state: WorkbenchState, contentId: string): Snapshot | undefined {
    return state.layoutSnapshots[contentId]
  },
}
