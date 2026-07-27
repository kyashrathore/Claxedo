import type { Accessor } from "solid-js"

import type { ContentMeta } from "../state/index"
import type { ClaxedoStateApi } from "../state/provider"
import type { RailWorktreeInfo } from "./rail-project-session-info"
import { createRailHeaderActions } from "./rail-header-actions"
import { NEW_TERMINAL_ID } from "@/features/terminal/core/terminal-surface-id"
import { useRailHeaderSurfaces } from "./rail-header-surfaces"
import { useRailWorkspacePanelTarget } from "./rail-workspace-panel-target"
import { useWorkspacePanelVisualState } from "./workspace-panel-visual-state"

type HeaderSurfaceInput = Parameters<typeof useRailHeaderSurfaces>[0]

export function useRailWorkbenchController(input: {
  activeDirectory: Accessor<string | undefined>
  autoResponds: HeaderSurfaceInput["autoResponds"]
  canUseDocuments: Accessor<boolean>
  client: HeaderSurfaceInput["client"]
  closeTerminal?: (terminalId: string) => void | Promise<unknown>
  emptyDraftDirectory: Accessor<string | undefined>
  focusedPaneWorkspaceDir: (paneId: string | undefined) => string | undefined
  onLastFocusedSurfaceClosed?: () => void
  onNewSession?: (workspaceDir?: string, paneId?: string) => void
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, paneId?: string) => void
  onTabClose?: (nextActiveTab: ContentMeta | undefined, closedTab: ContentMeta) => void
  onTabSelect?: (meta: ContentMeta) => void
  onWorkspacePanelVisibilityChange?: (visible: boolean) => void
  roleBlocksTerminal?: Accessor<boolean>
  sidebarDir: () => string | undefined
  state: ClaxedoStateApi
  workspacePanelWidth: Accessor<number>
  worktreeInfo: (workspaceDir: string) => RailWorktreeInfo | undefined
}) {
  const panelTarget = useRailWorkspacePanelTarget({
    state: input.state,
    activeDirectory: input.activeDirectory,
  })
  const terminalBlocked = () => panelTarget.focusedSurfaceWorkspaceToolsBlocked() || input.roleBlocksTerminal?.() === true
  const headerSurfaces = useRailHeaderSurfaces({
    state: input.state,
    client: input.client,
    canUseDocuments: input.canUseDocuments,
    worktreeInfo: input.worktreeInfo,
    autoResponds: input.autoResponds,
    closeTerminal: input.closeTerminal,
    onTabSelect: input.onTabSelect,
    onTabClose: input.onTabClose,
    onLastFocusedSurfaceClosed: input.onLastFocusedSurfaceClosed,
  })
  const headerActions = createRailHeaderActions({
    focusedPaneWorkspaceDir: input.focusedPaneWorkspaceDir,
    focusedSplitPaneId: panelTarget.focusedSplitPaneId,
    focusedSurfaceWorkspaceToolsBlocked: terminalBlocked,
    onNewSession: input.onNewSession,
    onNewTerminal: input.onNewTerminal,
    // Built here rather than drilled in from the shell: opening the creator is
    // just a surface open, and the controller already holds the state that does
    // it. Nothing about it needs the pty plumbing `onNewTerminal` carries.
    onNewTerminalDraft: (workspaceDir) => {
      input.state.layout.openTerminal(workspaceDir, NEW_TERMINAL_ID, "New Terminal")
    },
    sidebarDir: input.sidebarDir,
  })
  const panelVisual = useWorkspacePanelVisualState({
    claxedoState: input.state,
    focusedPanelTarget: panelTarget.focusedPanelTarget,
    focusedSplitPaneId: panelTarget.focusedSplitPaneId,
    focusedSurfaceWorkspaceToolsBlocked: panelTarget.focusedSurfaceWorkspaceToolsBlocked,
    activeDirectory: input.activeDirectory,
    emptyDraftDirectory: input.emptyDraftDirectory,
    onWorkspacePanelVisibilityChange: input.onWorkspacePanelVisibilityChange,
    workspacePanelWidth: input.workspacePanelWidth,
  })

  return {
    canUseTerminal: () => !terminalBlocked(),
    closeSurface: headerSurfaces.closeSurface,
    createHeaderSession: headerActions.createSession,
    createHeaderTerminal: headerActions.createTerminal,
    createHeaderTerminalDraft: headerActions.createTerminalDraft,
    focusedPanelTarget: panelVisual.focusedPanelTarget,
    hasWorkspacePanelTarget: panelVisual.hasWorkspacePanelTarget,
    registerWorkspacePanelFloatingChrome: panelVisual.registerWorkspacePanelFloatingChrome,
    registerWorkspacePanelShell: panelVisual.registerWorkspacePanelShell,
    registerWorkspacePanelWorkbenchColumn: panelVisual.registerWorkspacePanelWorkbenchColumn,
    selectSurface: headerSurfaces.selectSurface,
    switcherItems: headerSurfaces.switcherItems,
    toggleFocusedWorkspaceNavigator: panelVisual.toggleFocusedWorkspaceNavigator,
    toggleFocusedWorkspaceReview: panelVisual.toggleFocusedWorkspaceReview,
    workspacePanelBridgeChromeVisible: panelVisual.workspacePanelBridgeChromeVisible,
    workspacePanelForFocusedTarget: panelVisual.workspacePanelForFocusedTarget,
    workspacePanelMode: panelVisual.workspacePanelMode,
    workspacePanelNavigator: panelVisual.workspacePanelNavigator,
    workspacePanelVisualOpen: panelVisual.workspacePanelVisualOpen,
  }
}
