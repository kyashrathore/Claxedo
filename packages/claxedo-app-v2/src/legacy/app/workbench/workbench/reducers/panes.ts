import type { WorkbenchState } from "../types"

/**
 * Assign a pane's contentId.
 *  - Setting to null leaves the pane empty.
 *  - Setting to an existing alive content unbinds whichever other pane currently holds it.
 *  - Assigning a content not in contentIds is a no-op.
 */
export function assign(state: WorkbenchState, paneId: string, contentId: string | null): WorkbenchState {
  const paneIdx = state.panes.findIndex((p) => p.id === paneId)
  if (paneIdx === -1) return state

  if (contentId !== null && !state.contentIds.includes(contentId)) {
    return state
  }

  const panes = state.panes.map((p, i) => {
    if (i === paneIdx) return { ...p, contentId }
    if (contentId !== null && p.contentId === contentId) return { ...p, contentId: null }
    return p
  })
  return { ...state, panes }
}
