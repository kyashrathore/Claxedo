import { afterEach, describe, expect, test } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"

import { emptyClaxedoState } from "../state/persistence"
import type { ClaxedoState } from "../state/types"
import { createWorkspacePanelSlice } from "../state/workspace-panel"
import { useWorkspacePanelVisualState } from "./workspace-panel-visual-state"

const target = { workspaceDir: "/repo", targetPaneId: "pane-1" }

function mountVisualState() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const workspacePanel = createWorkspacePanelSlice({ state, setState, defaultTarget: () => target })
  return createRoot((dispose) => ({
    dispose,
    state,
    visual: useWorkspacePanelVisualState({
      claxedoState: { workspacePanel },
      focusedPanelTarget: () => target,
      focusedSplitPaneId: () => target.targetPaneId,
      focusedSurfaceWorkspaceToolsBlocked: () => false,
      activeDirectory: () => target.workspaceDir,
      emptyDraftDirectory: () => undefined,
      workspacePanelFullWidth: () => false,
      workspacePanelWidth: () => 520,
    }),
  }))
}

describe("toggleFocusedWorkspaceNavigator", () => {
  let dispose = () => {}
  afterEach(() => dispose())

  test("a repeat click toggles the navigator column off and keeps the panel open", () => {
    const mounted = mountVisualState()
    dispose = mounted.dispose

    mounted.visual.toggleFocusedWorkspaceNavigator("changes")
    expect(mounted.state.workspacePanel).toMatchObject({ open: true, mode: "review", navigator: "changes", ...target })
    expect(mounted.visual.workspacePanelVisualOpen()).toBe(true)

    mounted.visual.toggleFocusedWorkspaceNavigator("changes")
    expect(mounted.state.workspacePanel.open).toBe(true)
    expect(mounted.state.workspacePanel.navigator).toBeUndefined()
  })
})
