import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"

import {
  isGlobalPanelMode,
  shouldRetargetWorkspacePanelForFocusedPane,
  type WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import type { useClaxedoState } from "../state/index"
import { isWorkspaceReady } from "../../../features/workspaces/data/workspace-connection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createWorkspacePanelMotionState } from "./workspace-panel-motion-state"

export function useWorkspacePanelVisualState(input: {
  claxedoState: ReturnType<typeof useClaxedoState>
  focusedPanelTarget: () => WorkspacePanelPaneTarget | undefined
  focusedSplitPaneId: () => string | undefined
  focusedSurfaceWorkspaceToolsBlocked: () => boolean
  activeDirectory: Accessor<string | undefined>
  emptyDraftDirectory: Accessor<string | undefined>
  onWorkspacePanelVisibilityChange?: (visible: boolean) => void
  workspacePanelWidth: Accessor<number>
}) {
  const [workspacePanelHasRenderedOpen, setWorkspacePanelHasRenderedOpen] = createSignal(false)

  // The active global surface (e.g. WorkGraph) owns the panel when a global mode
  // is selected. The panel is only visible while that surface is focused.
  const activeSurfaceIsWorkGraph = () => {
    const id = input.claxedoState.wb.selectors.focusedContent()
    return !!id && input.claxedoState.meta.get(id)?.type === "workgraph"
  }
  // The last selected WorkGraph tab, derived straight from the panel slice: it
  // sticks on its previous value whenever the live panel mode is not a global
  // WorkGraph mode (a workspace mode or closed), so reopening the top-level
  // toggle restores that tab.
  const lastWorkGraphMode = createMemo<"workgraph-attention" | "workgraph-settings">((prev) => {
    const mode = input.claxedoState.workspacePanel.state().mode
    return isGlobalPanelMode(mode) ? mode : prev
  }, "workgraph-attention")

  const workspacePanelOpen = () => {
    const panel = input.claxedoState.workspacePanel.state()
    if (!(panel.open && !!panel.mode)) return false
    // Global-navigation modes are workspace-agnostic and only visible while their
    // owning global surface is focused; they bypass every workspace target gate.
    if (isGlobalPanelMode(panel.mode)) return activeSurfaceIsWorkGraph()
    if (!hasWorkspacePanelTarget() && !panel.workspaceDir) return false
    const workspaceId = panel.workspaceDir
      ? sessionWorkspaceRuntimeRef({ directory: panel.workspaceDir })?.workspaceId
      : undefined
    if (workspaceId && !isWorkspaceReady(workspaceId) && panel.mode !== "review" && !workspacePanelHasRenderedOpen()) return false
    return true
  }

  const initialWorkspacePanelOpen = workspacePanelOpen()
  const motion = createWorkspacePanelMotionState({
    initialOpen: initialWorkspacePanelOpen,
    workspacePanelWidth: input.workspacePanelWidth,
  })

  createEffect(() => {
    const committedOpen = workspacePanelOpen()
    if (!motion.reconcileCommittedOpen(committedOpen)) return
    input.onWorkspacePanelVisibilityChange?.(committedOpen)
    if (committedOpen) {
      setWorkspacePanelHasRenderedOpen(true)
      return
    }
    if (!input.claxedoState.workspacePanel.state().open) setWorkspacePanelHasRenderedOpen(false)
  })

  const workspacePanelNavigator = () => input.claxedoState.workspacePanel.state().navigator
  const workspacePanelMode = () => input.claxedoState.workspacePanel.state().mode
  const workspacePanelForFocusedTarget = () => {
    const target = input.focusedPanelTarget()
    const panel = input.claxedoState.workspacePanel.state()
    return !!target &&
      workspacePanelOpen() &&
      panel.workspaceDir === target.workspaceDir &&
      panel.targetPaneId === target.targetPaneId
  }

  let lastFocusedPanelTarget: WorkspacePanelPaneTarget | undefined
  createEffect(() => {
    const target = input.focusedPanelTarget()
    const previous = lastFocusedPanelTarget
    lastFocusedPanelTarget = target ? { ...target } : undefined

    const panel = input.claxedoState.workspacePanel.state()
    if (!target) return
    const staleSamePaneTarget = panel.open &&
      panel.targetPaneId === target.targetPaneId &&
      !!panel.workspaceDir &&
      panel.workspaceDir !== target.workspaceDir
    if (!staleSamePaneTarget && !shouldRetargetWorkspacePanelForFocusedPane(panel, previous, target)) return

    input.claxedoState.workspacePanel.retarget({
      workspaceDir: target.workspaceDir,
      targetPaneId: target.targetPaneId,
    })
  })

  function hasWorkspacePanelTarget() {
    return !!workspacePanelFallbackTarget()
  }

  function workspacePanelFallbackTarget() {
    if (input.focusedSurfaceWorkspaceToolsBlocked()) return
    const target = input.focusedPanelTarget()
    if (target) return target
    const panel = input.claxedoState.workspacePanel.state()
    if (panel.workspaceDir) {
      return {
        workspaceDir: panel.workspaceDir,
        targetPaneId: panel.targetPaneId ?? input.focusedSplitPaneId() ?? "",
      }
    }
    const workspaceDir = input.activeDirectory() ?? input.emptyDraftDirectory()
    if (!workspaceDir) return
    return {
      workspaceDir,
      targetPaneId: input.focusedSplitPaneId() ?? "",
    }
  }

  const openFocusedWorkspacePanel = (inputPanel: { navigator: "files" | "changes" | "processes" | null; focus?: null }) => {
    if (input.focusedSurfaceWorkspaceToolsBlocked()) return false
    const panel = input.claxedoState.workspacePanel.state()
    if (panel.open && panel.mode && panel.workspaceDir) {
      const target = input.focusedPanelTarget()
      input.claxedoState.workspacePanel.open("review", {
        workspaceDir: target?.workspaceDir ?? panel.workspaceDir,
        targetPaneId: target?.targetPaneId ?? panel.targetPaneId,
        navigator: inputPanel.navigator,
        focus: inputPanel.focus ?? null,
      })
      return true
    }
    const target = workspacePanelFallbackTarget()
    if (!target) return false
    input.claxedoState.workspacePanel.open("review", {
      workspaceDir: target.workspaceDir,
      targetPaneId: target.targetPaneId,
      navigator: inputPanel.navigator,
      focus: inputPanel.focus ?? null,
    })
    return true
  }

  const toggleFocusedWorkspaceNavigator = (navigator: "files" | "changes" | "processes") => {
    const opened = openFocusedWorkspacePanel({
      navigator: workspacePanelForFocusedTarget() && workspacePanelNavigator() === navigator ? null : navigator,
    })
    if (opened && !motion.visualOpenValue()) motion.setVisualPhase(true)
  }

  // The one physical top-level toggle drives the WorkGraph global panel while the
  // WorkGraph surface is active, restoring the last selected WorkGraph tab.
  const toggleWorkGraphPanel = (button?: HTMLButtonElement) => {
    const slice = input.claxedoState.workspacePanel
    if (motion.visualOpenValue() && isGlobalPanelMode(slice.state().mode)) {
      motion.setVisualPhase(false, button)
      slice.close()
      return
    }
    motion.setVisualPhase(true, button)
    slice.openGlobal(lastWorkGraphMode())
  }

  const toggleFocusedWorkspaceReview = (button?: HTMLButtonElement) => {
    if (activeSurfaceIsWorkGraph()) {
      toggleWorkGraphPanel(button)
      return
    }
    const panel = input.claxedoState.workspacePanel.state()
    const target = workspacePanelFallbackTarget()
    if (motion.visualOpenValue()) {
      motion.setVisualPhase(false, button)
      input.claxedoState.workspacePanel.close()
      return
    }
    if (input.focusedSurfaceWorkspaceToolsBlocked()) return
    const workspaceDir = target?.workspaceDir
    if (!workspaceDir) return
    motion.setVisualPhase(true, button)
    const reopenSameTarget = panel.workspaceDir === workspaceDir
    input.claxedoState.workspacePanel.open("review", reopenSameTarget
      ? {
        workspaceDir,
        targetPaneId: panel.targetPaneId ?? target?.targetPaneId,
        navigator: null,
        focus: null,
      }
      : {
        workspaceDir,
        targetPaneId: target?.targetPaneId,
        navigator: null,
        focus: null,
      })
  }

  return {
    focusedPanelTarget: input.focusedPanelTarget,
    hasWorkspacePanelTarget,
    toggleFocusedWorkspaceNavigator,
    toggleFocusedWorkspaceReview,
    registerWorkspacePanelFloatingChrome: motion.registerFloatingChrome,
    registerWorkspacePanelShell: motion.registerPanelShell,
    registerWorkspacePanelWorkbenchColumn: motion.registerWorkbenchColumn,
    workspacePanelBridgeChromeVisible: motion.bridgeChromeVisible,
    workspacePanelForFocusedTarget,
    workspacePanelMode,
    workspacePanelNavigator,
    workspacePanelOpen,
    workspacePanelVisualOpen: motion.visualOpen,
  }
}
