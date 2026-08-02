import type { WorkbenchState } from "./types"
import { nextPaneId } from "./reducers/tree-helpers"

export const constructWorkbenchState = {
  empty(): WorkbenchState {
    return {
      panes: [],
      split: { direction: "h", sizes: [], root: undefined },
      contentIds: [],
      contentRecency: [],
      focusedPaneId: null,
      layoutSnapshots: {},
    }
  },

  singlePane(contentId: string): WorkbenchState {
    const id = nextPaneId()
    return {
      panes: [{ id, contentId }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id } },
      contentIds: [],
      contentRecency: [],
      focusedPaneId: id,
      layoutSnapshots: {},
    }
  },
}
