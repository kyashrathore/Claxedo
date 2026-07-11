import { createEffect, createSignal, type Accessor } from "solid-js"

import {
  shouldRetargetWorkspacePanelForFocusedPane,
  type WorkspacePanelPaneTarget,
} from "../workspace-panel/workspace-panel-state"
import type { useClaxedoState } from "../state"
import { isWorkspaceReady } from "../../shell/workspace/workspace-connection"
import { sessionWorkspaceRuntimeRef } from "../../shell/workspace/session-workspace-key"
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

  const workspacePanelOpen = () => {
    const panel = input.claxedoState.workspacePanel.state()
    if (!(panel.open && !!panel.mode)) return false
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

  const toggleFocusedWorkspaceReview = (button?: HTMLButtonElement) => {
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
