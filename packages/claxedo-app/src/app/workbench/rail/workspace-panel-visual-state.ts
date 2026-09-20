import { createEffect, createSignal, type Accessor } from "solid-js"

import {
  shouldRetargetWorkspacePanelForFocusedPane,
  type WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import type { ClaxedoStateApi } from "../state/provider"
import { isWorkspaceReady } from "../../../features/workspaces/data/workspace-connection"
import type { ReviewWorkspaceTab } from "@/features/review/ui/review-workspace-tabs"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createWorkspacePanelMotionState } from "./workspace-panel-motion-state"
import { workspacePanelChosenSurface } from "../review/review-workspace-working-set"

export function workspacePanelMatchesFocusedPane(input: {
  open: boolean
  panel: { targetPaneId?: string }
  target?: WorkspacePanelPaneTarget
}) {
  if (!input.open) return false
  // A targetless panel is attached to the currently focused pane. Providers
  // can open one before workbench hydration produces a stable pane id.
  if (input.panel.targetPaneId === undefined) return true
  // Compared by pane id, not directory: the panel's directory and the focused
  // surface's tool directory can be two aliases of one workspace (its id
  // versus its filesystem cwd).
  return input.panel.targetPaneId === input.target?.targetPaneId
}

export function workspacePanelTopLevelOpenTarget(
  panel: {
    workspaceDir?: string
    targetPaneId?: string
    navigator?: "files" | "changes" | "processes"
    focus?: unknown
  },
  target: WorkspacePanelPaneTarget,
  chosenSurface: ReviewWorkspaceTab | undefined,
) {
  const paneTarget = {
    workspaceDir: target.workspaceDir,
    targetPaneId: panel.workspaceDir === target.workspaceDir
      ? panel.targetPaneId ?? target.targetPaneId
      : target.targetPaneId,
  }
  // Naming neither navigator nor focus leaves both as the user left them, so
  // the surface they picked comes back instead of being reopened underneath
  // Files and Review.
  if (chosenSurface) return paneTarget
  return {
    ...paneTarget,
    // Files is the useful workspace default and lets the shell begin loading
    // the tree at the opening click.
    navigator: panel.navigator ?? "files",
    // The physical top-level button means “open Workspace”, whose primary
    // surface is Review. Preserve every warm inner tab in the working set, but
    // activate Review rather than an arbitrary tab from the last close.
    // A focus request still present here has not been consumed (consumption
    // clears it in WorkspacePanelBody). It represents a more recent explicit
    // file/process/context action and must win over the generic open button.
    ...(panel.focus ? {} : { focus: { kind: "review" as const } }),
  }
}

/**
 * Full view has room for a navigator column, and an unselected one leaves it
 * empty. Returns the retarget that fills it, or nothing when the panel already
 * has a column or is showing a surface the user chose — Browser and file tabs
 * run full-bleed, so a column slides over what they came to look at.
 */
export function workspacePanelFullWidthNavigatorTarget(
  panel: {
    open: boolean
    workspaceDir?: string
    targetPaneId?: string
    navigator?: "files" | "changes" | "processes"
  },
  chosenSurface: ReviewWorkspaceTab | undefined,
) {
  if (!panel.open || panel.navigator || chosenSurface) return undefined
  return {
    workspaceDir: panel.workspaceDir,
    targetPaneId: panel.targetPaneId,
    navigator: "changes" as const,
  }
}

export function useWorkspacePanelVisualState(input: {
  claxedoState: Pick<ClaxedoStateApi, "workspacePanel">
  focusedPanelTarget: () => WorkspacePanelPaneTarget | undefined
  focusedSplitPaneId: () => string | undefined
  focusedSurfaceWorkspaceToolsBlocked: () => boolean
  activeDirectory: Accessor<string | undefined>
  emptyDraftDirectory: Accessor<string | undefined>
  onWorkspacePanelVisibilityChange?: (visible: boolean) => void
  workspacePanelFullWidth: Accessor<boolean>
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
    workspacePanelFullWidth: input.workspacePanelFullWidth,
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
    return workspacePanelMatchesFocusedPane({ open: workspacePanelOpen(), panel, target })
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
    if (input.focusedSurfaceWorkspaceToolsBlocked()) return undefined
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
    if (!workspaceDir) return undefined
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

  const chosenSurface = (workspaceDir: string | undefined) => workspacePanelChosenSurface({
    reviewWorkingSet: input.claxedoState.workspacePanel.reviewWorkingSet,
    workspaceDir,
  })

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
    input.claxedoState.workspacePanel.open(
      "review",
      workspacePanelTopLevelOpenTarget(panel, target, chosenSurface(workspaceDir)),
    )
  }

  const seedWorkspacePanelNavigatorForFullWidth = () => {
    const panel = input.claxedoState.workspacePanel.state()
    const target = workspacePanelFullWidthNavigatorTarget(panel, chosenSurface(panel.workspaceDir))
    if (target) input.claxedoState.workspacePanel.retarget(target)
  }

  return {
    focusedPanelTarget: input.focusedPanelTarget,
    hasWorkspacePanelTarget,
    seedWorkspacePanelNavigatorForFullWidth,
    toggleFocusedWorkspaceNavigator,
    toggleFocusedWorkspaceReview,
    registerWorkspacePanelFloatingChrome: motion.registerFloatingChrome,
    registerWorkspacePanelShell: motion.registerPanelShell,
    registerWorkspacePanelWorkbenchColumn: motion.registerWorkbenchColumn,
    workspacePanelBridgeChromeVisible: motion.bridgeChromeVisible,
    workspacePanelForFocusedTarget,
    workspacePanelMode,
    workspacePanelNavigator,
    workspacePanelMounted: motion.shellMounted,
    workspacePanelOpen,
    workspacePanelVisualOpen: motion.visualOpen,
  }
}
