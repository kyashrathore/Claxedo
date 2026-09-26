import { REVIEW_TAB_ID } from "./workspace-tabs"

export function closeReviewWorkspaceTab(input: { id: string; closePanel: () => void; closeTab: (id: string) => void }) {
  if (input.id === REVIEW_TAB_ID) {
    input.closePanel()
    return
  }
  input.closeTab(input.id)
}
