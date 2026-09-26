import type { WorkbenchState } from "../types"

export function assign(state: WorkbenchState, paneId: string, contentId: string | null): WorkbenchState {
  const paneIndex = state.panes.findIndex((p) => p.id === paneId)
  if (paneIndex === -1) return state
  if (contentId !== null && !state.contentIds.includes(contentId)) return state
  const panes = state.panes.map((p, i) => {
    if (i === paneIndex) return { ...p, contentId }
    if (contentId !== null && p.contentId === contentId) return { ...p, contentId: null }
    return p
  })
  return { ...state, panes }
}
