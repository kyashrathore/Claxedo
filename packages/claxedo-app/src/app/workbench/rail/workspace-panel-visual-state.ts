import { createEffect, createSignal, type Accessor } from "solid-js"

import {
  isGlobalPanelMode,
  shouldRetargetWorkspacePanelForFocusedPane,
  type GlobalPanelMode,
  type WorkspacePanelPaneTarget,
} from "../../../features/workspaces/ui/panel/workspace-panel-state"
import type { useClaxedoState } from "../state/index"
import { isWorkspaceReady } from "../../../features/workspaces/data/workspace-connection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { createWorkspacePanelMotionState } from "./workspace-panel-motion-state"

export function workspacePanelMatchesFocusedPane(input: {
  open: boolean
  panel: { targetPaneId?: string }
  target?: WorkspacePanelPaneTarget
}) {
  if (!input.open) return false
  // A targetless panel is attached to the currently focused pane. Providers
  // can open one before workbench hydration produces a stable pane id.
  if (input.panel.targetPaneId === undefined) return true
  // UI ownership is pane-scoped. The panel directory and the focused surface's
  // tool directory may be canonical aliases of the same local workspace (for
  // example a resolved local workspace id versus its filesystem cwd).
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
) {
  return {
    workspaceDir: target.workspaceDir,
    targetPaneId: panel.workspaceDir === target.workspaceDir
      ? panel.targetPaneId ?? target.targetPaneId
      : target.targetPaneId,
    // A first top-level open has no prior surface to restore. Files is the
    // useful workspace default and lets the shell begin loading the tree at
    // the opening click; later closes/reopens preserve the user's selection.
    navigator: panel.navigator ?? "files",
    // The physical top-level button means “open Workspace”, whose primary
    // surface is Review. Preserve every warm inner tab in the working set, but
    // explicitly reactivate Review instead of restoring an arbitrary process
    // or file tab from the last close.
    // A focus request still present here has not been consumed (consumption
    // clears it in WorkspacePanelBody). It represents a more recent explicit
    // file/process/context action and must win over the generic open button.
    ...(panel.focus ? {} : { focus: { kind: "review" as const } }),
  }
}

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
  let retainedWorkGraphMode: GlobalPanelMode = "workgraph-attention"
  const lastWorkGraphMode = () => {
    const mode = input.claxedoState.workspacePanel.state().mode
    if (isGlobalPanelMode(mode)) retainedWorkGraphMode = mode
    return retainedWorkGraphMode
  }

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
    if (workspaceId && !isWorkspaceReady(workspaceId) && panel.mode !== "review" && !workspacePanelHasRenderedOpen())
      return false
    return true
  }

  const initialWorkspacePanelOpen = workspacePanelOpen()
  const motion = createWorkspacePanelMotionState({
    initialOpen: initialWorkspacePanelOpen,
    workspacePanelWidth: input.workspacePanelWidth,
  })

  // `workspacePanelOpen()` reads `workspacePanelHasRenderedOpen` and this body
  // writes it, so tracking and the write shared one scope. The write is now
  // untracked. The compute returns a fresh box on purpose: a panel close that
  // leaves the committed value at false is what clears the rendered latch, so
  // the reconcile must still run on every invalidation, not only on a flip.
  createEffect(
    () => ({ committedOpen: workspacePanelOpen() }),
    ({ committedOpen }) => {
      if (!motion.reconcileCommittedOpen(committedOpen)) return
      input.onWorkspacePanelVisibilityChange?.(committedOpen)
      if (committedOpen) {
        setWorkspacePanelHasRenderedOpen(true)
        return
      }
      if (!input.claxedoState.workspacePanel.state().open) setWorkspacePanelHasRenderedOpen(false)
    },
  )

  const workspacePanelNavigator = () => input.claxedoState.workspacePanel.state().navigator
  const workspacePanelMode = () => input.claxedoState.workspacePanel.state().mode
  const workspacePanelForFocusedTarget = () => {
    const target = input.focusedPanelTarget()
    const panel = input.claxedoState.workspacePanel.state()
    return workspacePanelMatchesFocusedPane({ open: workspacePanelOpen(), panel, target })
  }

  // The focused target is the trigger; the panel slice is only consulted for its
  // current value, and `retarget` writes it — reading it in the tracking scope
  // made this effect feed itself an extra settling pass after every retarget.
  let lastFocusedPanelTarget: WorkspacePanelPaneTarget | undefined
  createEffect(input.focusedPanelTarget, (target) => {
    const previous = lastFocusedPanelTarget
    lastFocusedPanelTarget = target ? { ...target } : undefined
    if (!target) return

    const panel = input.claxedoState.workspacePanel.state()
    const staleSamePaneTarget =
      panel.open &&
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

  const openFocusedWorkspacePanel = (inputPanel: {
    navigator: "files" | "changes" | "processes" | null
    focus?: null
  }) => {
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
    // The panel state preserves the warm working set. The target carries a
    // Review focus request so both a fresh remount and an interrupted reopen
    // activate the panel's primary surface without discarding those tabs.
    input.claxedoState.workspacePanel.open("review", workspacePanelTopLevelOpenTarget(panel, target))
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
    workspacePanelMounted: motion.shellMounted,
    workspacePanelOpen,
    workspacePanelVisualOpen: motion.visualOpen,
  }
}
