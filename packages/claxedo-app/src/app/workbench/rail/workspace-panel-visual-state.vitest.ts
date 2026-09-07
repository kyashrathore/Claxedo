import { afterEach, describe, expect, test } from "vitest"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"

import type { NavigatorPlacement } from "@/platform/settings/provider"
import { createNavigatorSlice } from "../state/navigator"
import { emptyClaxedoState } from "../state/persistence"
import type { ClaxedoState } from "../state/types"
import { createWorkspacePanelSlice } from "../state/workspace-panel"
import { useWorkspacePanelVisualState } from "./workspace-panel-visual-state"

const target = { workspaceDir: "/repo", targetPaneId: "pane-1" }

function mountVisualState(placement: NavigatorPlacement) {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const workspacePanel = createWorkspacePanelSlice({ state, setState, defaultTarget: () => target })
  const navigator = createNavigatorSlice({ state, setState })
  const [navigatorPlacement] = createSignal(placement)
  return createRoot((dispose) => ({
    dispose,
    state,
    navigator,
    visual: useWorkspacePanelVisualState({
      claxedoState: { workspacePanel, navigator },
      focusedPanelTarget: () => target,
      focusedSplitPaneId: () => target.targetPaneId,
      focusedSurfaceWorkspaceToolsBlocked: () => false,
      activeDirectory: () => target.workspaceDir,
      emptyDraftDirectory: () => undefined,
      navigatorPlacement,
      workspacePanelFullWidth: () => false,
      workspacePanelWidth: () => 520,
    }),
  }))
}

describe("toggleFocusedWorkspaceNavigator", () => {
  let dispose = () => {}
  afterEach(() => dispose())

  test("panel placement toggles the navigator column off on a repeat click", () => {
    const mounted = mountVisualState("panel")
    dispose = mounted.dispose
    const initialTab = mounted.navigator.tab()

    mounted.visual.toggleFocusedWorkspaceNavigator("changes")
    expect(mounted.state.workspacePanel).toMatchObject({ open: true, mode: "review", navigator: "changes", ...target })
    expect(mounted.visual.workspacePanelVisualOpen()).toBe(true)

    mounted.visual.toggleFocusedWorkspaceNavigator("changes")
    expect(mounted.state.workspacePanel.open).toBe(true)
    expect(mounted.state.workspacePanel.navigator).toBeUndefined()
    expect(mounted.navigator.tab()).toBe(initialTab)
  })

  test("sidebar placement selects the navigator tab and keeps it selected on a repeat click", () => {
    const mounted = mountVisualState("sidebar")
    dispose = mounted.dispose

    mounted.visual.toggleFocusedWorkspaceNavigator("processes")
    expect(mounted.navigator.tab()).toBe("processes")
    expect(mounted.state.workspacePanel).toMatchObject({ open: true, mode: "review", navigator: "processes", ...target })
    expect(mounted.visual.workspacePanelVisualOpen()).toBe(true)

    mounted.visual.toggleFocusedWorkspaceNavigator("processes")
    expect(mounted.navigator.tab()).toBe("processes")
    expect(mounted.state.workspacePanel).toMatchObject({ open: true, navigator: "processes" })
    expect(mounted.visual.workspacePanelVisualOpen()).toBe(true)

    mounted.visual.toggleFocusedWorkspaceNavigator("files")
    expect(mounted.navigator.tab()).toBe("files")
    expect(mounted.state.workspacePanel).toMatchObject({ open: true, navigator: "files" })
  })
})
