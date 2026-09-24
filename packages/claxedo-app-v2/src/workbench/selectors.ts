import type { Pane, PaneRect, Snapshot, WorkbenchState } from "./types"
import { computePaneRects, leafIdsInOrder } from "./reducers/tree-helpers"

export const selectors = {
  aliveContents(state: WorkbenchState): readonly string[] {
    return state.contentIds
  },

  recentContents(state: WorkbenchState): readonly string[] {
    return state.contentRecency
  },

  contentPane(state: WorkbenchState, contentId: string): string | null {
    return state.panes.find((p) => p.contentId === contentId)?.id ?? null
  },

  visiblePanes(state: WorkbenchState): readonly Pane[] {
    const panes = new Map(state.panes.map((pane) => [pane.id, pane]))
    return leafIdsInOrder(state.split.root).flatMap((id) => {
      const pane = panes.get(id)
      return pane ? [pane] : []
    })
  },

  paneRect(state: WorkbenchState, paneId: string): PaneRect | undefined {
    return computePaneRects(state.split.root).get(paneId)
  },

  focusedContent(state: WorkbenchState): string | null {
    if (!state.focusedPaneId) return null
    return state.panes.find((p) => p.id === state.focusedPaneId)?.contentId ?? null
  },

  mruHiddenContent(state: WorkbenchState): string | null {
    const bound = new Set(state.panes.map((p) => p.contentId).filter((id): id is string => !!id))
    const focused = selectors.focusedContent(state)
    for (const id of state.contentRecency) {
      if (id === focused || !state.contentIds.includes(id) || bound.has(id)) continue
      return id
    }
    return null
  },

  snapshotFor(state: WorkbenchState, contentId: string): Snapshot | undefined {
    return state.layoutSnapshots[contentId]
  },
}
