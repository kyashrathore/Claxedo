import { afterEach, describe, expect, test } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"

import { BROWSER_TAB_ID, REVIEW_TAB, REVIEW_TAB_ID } from "@/features/review/ui/review-workspace-tabs"
import { emptyClaxedoState } from "../state/persistence"
import type { ClaxedoState } from "../state/types"
import { createWorkspacePanelSlice } from "../state/workspace-panel"
import { useWorkspacePanelVisualState } from "./workspace-panel-visual-state"
import { panelReviewWorkingSetKey } from "../review/review-workspace-working-set"

const target = { workspaceDir: "/repo", targetPaneId: "pane-1" }

function mountVisualState() {
  const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
  const workspacePanel = createWorkspacePanelSlice({ state, setState, defaultTarget: () => target })
  return createRoot((dispose) => ({
    dispose,
    state,
    workspacePanel,
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

function retainBrowserSurface(mounted: ReturnType<typeof mountVisualState>) {
  mounted.workspacePanel.reviewWorkingSet.set(panelReviewWorkingSetKey({ directory: target.workspaceDir }), {
    tabs: [
      REVIEW_TAB,
      { id: BROWSER_TAB_ID, kind: "browser", browserId: "workspace-browser:/repo", url: "http://localhost:6006" },
    ],
    activeTabId: BROWSER_TAB_ID,
    review: { scroll: { top: 0 } },
  })
}

function retainReviewSurface(mounted: ReturnType<typeof mountVisualState>) {
  mounted.workspacePanel.reviewWorkingSet.set(panelReviewWorkingSetKey({ directory: target.workspaceDir }), {
    tabs: [REVIEW_TAB],
    activeTabId: REVIEW_TAB_ID,
    review: { scroll: { top: 0 } },
  })
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

describe("toggleFocusedWorkspaceReview", () => {
  let dispose = () => {}
  afterEach(() => dispose())

  test("reopens onto the browser surface the user chose, with no navigator over it", () => {
    const mounted = mountVisualState()
    dispose = mounted.dispose
    retainBrowserSurface(mounted)

    mounted.visual.toggleFocusedWorkspaceReview()

    expect(mounted.state.workspacePanel).toMatchObject({ open: true, mode: "review", ...target })
    expect(mounted.state.workspacePanel.navigator).toBeUndefined()
    expect(mounted.state.workspacePanel.focus).toBeUndefined()
  })

  test("a cold open lands on Files and Review", () => {
    const mounted = mountVisualState()
    dispose = mounted.dispose

    mounted.visual.toggleFocusedWorkspaceReview()

    expect(mounted.state.workspacePanel).toMatchObject({ open: true, mode: "review", navigator: "files", ...target })
    expect(mounted.state.workspacePanel.focus).toMatchObject({ kind: "review" })
  })

  test("a working set resting on Review is a cold open", () => {
    const mounted = mountVisualState()
    dispose = mounted.dispose
    retainReviewSurface(mounted)

    mounted.visual.toggleFocusedWorkspaceReview()

    expect(mounted.state.workspacePanel.navigator).toBe("files")
    expect(mounted.state.workspacePanel.focus).toMatchObject({ kind: "review" })
  })
})

describe("seedWorkspacePanelNavigatorForFullWidth", () => {
  let dispose = () => {}
  afterEach(() => dispose())

  test("leaves the browser surface the user chose full-bleed", () => {
    const mounted = mountVisualState()
    dispose = mounted.dispose
    retainBrowserSurface(mounted)
    mounted.workspacePanel.open("review", { ...target, navigator: null, focus: null })

    mounted.visual.seedWorkspacePanelNavigatorForFullWidth()

    expect(mounted.state.workspacePanel.navigator).toBeUndefined()
    expect(mounted.state.workspacePanel.focus).toBeUndefined()
  })

  test("fills the empty column of a panel resting on Review", () => {
    const mounted = mountVisualState()
    dispose = mounted.dispose
    mounted.workspacePanel.open("review", { ...target, navigator: null, focus: null })

    mounted.visual.seedWorkspacePanelNavigatorForFullWidth()

    expect(mounted.state.workspacePanel.navigator).toBe("changes")
  })
})
