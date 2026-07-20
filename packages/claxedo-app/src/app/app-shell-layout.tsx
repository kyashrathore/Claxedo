/**
 * App Shell Layout
 *
 * The main layout component implementing the rail, surface canvas, and workspace panel.
 * This wraps/replaces the upstream layout when Claxedo mode is enabled.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                        Titlebar                              │
 * ├────────┬────────────────────────────────────────────────────┤
 * │        │  [Surface switcher]        │ workspace controls     │
 * │  Rail  ├────────────────────────────────────────────────────┤
 * │        │                                                     │
 * │        │               Surface Canvas                        │
 * │        │                                                     │
 * └────────┴────────────────────────────────────────────────────┘
 */

import {
  createMemo,
  type ParentProps,
  type JSX,
} from "solid-js"
import { useClaxedoState, type ContentMeta } from "./workbench/state/index"
import type { ProjectItem } from "./workbench/rail/domain-types"
import { emitTerminalFit } from "../features/terminal/workbench/terminal-fit"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useOptionalTerminal } from "@/features/terminal/providers/provider"
import { usePermission } from "@/features/session/providers/permission"
import { useCommand, useServer, usePlatform } from "@claxedo/app"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useRailKeyboardController } from "./workbench/rail/rail-keyboard-controller"
import { useRailEmptyDraftController } from "./workbench/rail/rail-empty-draft-controller"
import { useRailShellChromeState } from "./workbench/rail/rail-shell-chrome-state"
import { isNarrowViewport } from "./workbench/workbench/index"
import { RailSidebarShell } from "./workbench/rail/rail-sidebar-shell"
import { RailWorkbenchShell } from "./workbench/rail/rail-workbench-shell"
import { useRailWorkbenchController } from "./workbench/rail/rail-workbench-controller"
import { terminalBlockedByRole } from "../features/terminal/core/terminal-role-gate"
import { workspacePlacement } from "../features/workspaces/data/workspace-connection"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { useRailSidebarSelection } from "./workbench/rail/rail-sidebar-selection"
import { useRailProjectSessionInfo } from "./workbench/rail/rail-project-session-info"
import {
  applyLayoutCommand,
  workspacePanelFullWidthCommand,
} from "./layout/commands"
import { createShellLayoutState } from "./layout/state"
import { focusComposerSurface } from "../features/session/composer/ui/composer-focus"
import "./styles/ui-overrides.css"

export type AppShellLayoutProps = ParentProps<{
  /**
   * List of projects to display in the rail
   */
  projects: ProjectItem[]

  /**
   * Currently active project ID
   */
  activeProjectId?: string

  /**
   * Currently active worktree directory (route)
   */
  activeDirectory?: string

  /**
   * Currently active session ID
   */
  activeSessionId?: string
  globalChatEnabled?: boolean
  canUseDocuments?: boolean

  /**
   * Home directory for path shortening
   */
  homedir?: string

  /**
   * Callback when a worktree is selected
   */
  onWorkspaceSelect?: (project: ProjectItem, workspaceDir: string) => void

  /**
   * Callback when a session is selected
   */
  onSessionSelect?: (workspaceDir: string, sessionId: string) => void

  /**
   * Callback to create a new project
   */
  onNewProject?: () => void

  /**
   * Callback to open settings
   */
  onSettings?: () => void

  /**
   * Callback to open help
   */
  onHelp?: () => void

  /**
   * Callback to open the Marketplace as an in-workbench tab.
   */
  onOpenMarketplace?: () => void
  /** Open the personal WorkGraph as a reusable global tab. */
  onOpenWorkGraph?: () => void

  /**
   * Callback to create a new session. When no workspace is selected yet,
   * callers may pass `undefined` to create an unattached draft first.
   */
  onNewSession?: (workspaceDir?: string, paneId?: string) => void
  suppressEmptyDraftSession?: boolean
  onDeleteSession?: (session: import("./workbench/rail/domain-types").SessionItem) => void
  onArchiveSession?: (session: import("./workbench/rail/domain-types").SessionItem) => boolean | Promise<boolean>
  onDeleteWorkspace?: (workspace: import("./workbench/rail/domain-types").WorkspaceItem) => void
  onRemoveProject?: (project: import("./workbench/rail/domain-types").ProjectItem) => void

  /**
   * Callback to create a new terminal
   * @param workspaceDir - The workspace directory to create the terminal in
   * @param command - Optional command to run in the terminal (e.g., "claude --dangerously-skip-permissions")
   * @param title - Optional title for the terminal surface (e.g., "Claude", "Codex")
   */
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, paneId?: string) => void

  /**
   * Callback to create a new page
   */
  onNewPage?: () => void

  /**
   * Callback when a surface is selected.
   */
  onTabSelect?: (surface: ContentMeta) => void

  /**
   * Callback when a surface is closed (to sync URL with the next active surface).
   */
  onTabClose?: (nextActiveTab: ContentMeta | undefined, closedTab: ContentMeta) => void

  /**
   * Additional content for the top bar (right side)
   */
  topBarRight?: () => JSX.Element
}>

function AppShellLayoutBody(props: AppShellLayoutProps) {
  const claxedoState = useClaxedoState()
  const command = useCommand()
  const platform = usePlatform()
  const server = useServer()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const terminal = useOptionalTerminal()
  const permission = usePermission()
  const projectSessionInfo = useRailProjectSessionInfo({
    baseUrl: () => globalSDK.url,
    mainIsCloud: () => !server.isLocal(),
    projects: () => props.projects,
  })

  const chrome = useRailShellChromeState({
    isMac: platform.platform === "desktop" && platform.os === "macos",
    paneCount: () => claxedoState.wb.state.panes.length,
    splitRoot: () => claxedoState.wb.state.split.root,
  })

  const emptyDraft = useRailEmptyDraftController({
    state: claxedoState,
    projects: () => props.projects,
    activeDirectory: () => props.activeDirectory,
    autoOpenDisabled: () => props.suppressEmptyDraftSession,
    onNewSession: props.onNewSession,
  })

  const sidebarSelection = useRailSidebarSelection({
    state: claxedoState,
    projects: () => props.projects,
    activeProjectId: () => props.activeProjectId,
    activeDirectory: () => props.activeDirectory,
    projectCaption: projectSessionInfo.projectCaption,
    worktreeInfo: projectSessionInfo.worktreeInfo,
  })
  const initialRailWidth = claxedoState.rail.width() || 260
  const initialRailLayoutState = {
    collapsed: claxedoState.rail.collapsed(),
    pinned: claxedoState.rail.pinned(),
    width: initialRailWidth,
  }
  const initialPanel = claxedoState.workspacePanel.state()
  const shellLayout = createShellLayoutState({
    target: () => platform.platform === "desktop" ? "desktop" : "web",
    initialRail: initialRailLayoutState,
    initialWorkspacePanel: {
      open: initialPanel.open && !!initialPanel.mode,
      width: 520,
    },
  })
  const workbenchController = useRailWorkbenchController({
    activeDirectory: () => props.activeDirectory,
    autoResponds: (request, workspaceDir) => permission.autoResponds(request, workspaceDir),
    canUseDocuments: () => props.canUseDocuments === true,
    client: globalSDK.client,
    closeTerminal: (terminalId) => terminal?.close(terminalId),
    emptyDraftDirectory: emptyDraft.emptyDraftDirectory,
    focusedPaneWorkspaceDir: sidebarSelection.focusedPaneWorkspaceDir,
    onLastFocusedSurfaceClosed: emptyDraft.blockNextAutoOpen,
    onNewSession: props.onNewSession,
    onNewTerminal: props.onNewTerminal,
    onTabClose: props.onTabClose,
    onTabSelect: props.onTabSelect,
    onWorkspacePanelVisibilityChange: shellLayout.setWorkspacePanelOpen,
    roleBlocksTerminal: () => terminalBlockedByRole(workspacePlacement(
      props.activeDirectory ? sessionWorkspaceRuntimeRef({ directory: props.activeDirectory })?.workspaceId : undefined,
    )),
    sidebarDir: sidebarSelection.sidebarDir,
    state: claxedoState,
    workspacePanelWidth,
    worktreeInfo: projectSessionInfo.worktreeInfo,
  })
  const layoutConfig = shellLayout.config
  const railRegion = () => layoutConfig().regions.rail
  const workspacePanelRegion = () => layoutConfig().regions.workspacePanel
  const sidebarWidth = () => railRegion().size.unit === "px" ? railRegion().size.value : 260
  const sidebarExpanded = () => sidebarWidth() > 0
  const sidebarPinned = () => railRegion().docked !== false
  const sidebarHidden = () => !sidebarPinned() && sidebarWidth() === 0
  const workspacePanelFullWidth = () =>
    workspacePanelRegion().size.unit === "percent" && workspacePanelRegion().size.value === 100
  const workspacePanelOpen = () => workspacePanelRegion().visible
  const toggleWorkspacePanelFullWidth = () => {
    const command = workspacePanelFullWidthCommand(layoutConfig(), shellLayout.workspacePanelWidth())
    const next = applyLayoutCommand(layoutConfig(), command)
    const fullWidth = next.regions.workspacePanel.size.unit === "percent" &&
      next.regions.workspacePanel.size.value === 100
    shellLayout.dispatch("workspacePanelSize", fullWidth ? command : undefined)
    emitTerminalFit()
  }
  const toggleWorkspacePanel = (button: HTMLButtonElement) => {
    if (workspacePanelFullWidth() && workspacePanelOpen()) {
      shellLayout.dispatch("workspacePanelSize", undefined)
    }
    workbenchController.toggleFocusedWorkspaceReview(button)
  }
  const toggleSidebar = () => {
    shellLayout.toggleRail()
  }
  // At narrow width the rail is a drawer and the desktop pinned-rail toggle is
  // meaningless — the header "Show Sidebar" affordance must open the mobile
  // drawer instead (WP-C3 collapse design §3.1).
  const showSidebar = () => {
    if (isNarrowViewport()) {
      chrome.openMobileSidebar()
      return
    }
    toggleSidebar()
  }
  const resizeSidebar = (width: number) => {
    shellLayout.setRailWidth(width)
  }
  const commitSidebarResize = () => {
    claxedoState.rail.setWidth(shellLayout.committedRailWidth())
  }
  const handleSidebarHotZoneEnter = () => {
    if (sidebarPinned() || sidebarExpanded()) return
    // After a toggle-collapse the peek is muted until the pointer leaves the
    // corner; without this the Show-Sidebar button rendering under the still
    // cursor would immediately re-peek the rail we just hid.
    if (shellLayout.railMuted()) return
    shellLayout.peekRail(true)
  }
  const handleSidebarMouseLeave = () => {
    shellLayout.collapseFloatingRail()
  }
  useRailKeyboardController({ state: claxedoState, command, dialog, platform, toggleSidebar })

  function workspacePanelWidth() {
    return shellLayout.workspacePanelWidth()
  }
  return (
    <div class="flex flex-col w-full h-full bg-background-base overflow-hidden" data-claxedo>
      {/* Desktop window chrome spacer - for macOS traffic lights / Windows title bar */}

      {/* Skip link: the project/session tree in the sidebar renders one tab stop
          per row/action (hundreds), which buries the composer at the very end of
          the tab order. This WCAG 2.4.1 bypass is the first focusable element, so
          one Tab + Enter jumps a keyboard user straight to the composer. It stays
          visually hidden until focused. */}
      <button
        type="button"
        data-testid="skip-to-composer"
        class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface-raised-base focus:px-3 focus:py-1.5 focus:text-13-regular focus:text-text-base focus:shadow focus:outline-none"
        onClick={() => focusComposerSurface()}
      >
        Skip to composer
      </button>

      <div class="flex flex-1 min-h-0 overflow-hidden relative">
        {/* The sidebar stays hidden until the first project exists. On a
            brand-new (zero-project) account the only thing the user sees is
            the centered empty state + New Project CTA. As soon as a project
            is added it appears here (pinned by default). */}
        {/* `role="navigation"` landmark (via `class="contents"` so it adds no
            layout box — the sidebar shell stays the flex child) so the sidebar's
            content lives inside a landmark (axe `region`) alongside the
            workbench `main`. Single nav on the page, so no label is required. */}
        <nav class="contents">
        <RailSidebarShell
          activeGlobal={emptyDraft.activeGlobal}
          activeProjectId={props.activeProjectId}
          activeSessionId={props.activeSessionId}
          activeDirectory={props.activeDirectory}
          closeMobileSidebar={chrome.closeMobileSidebar}
          globalChatEnabled={props.globalChatEnabled}
          hasOpenSurfaces={emptyDraft.hasOpenSurfaces}
          headerSubtitle={() => emptyDraft.activeGlobal() ? undefined : sidebarSelection.sidebarProjectName()}
          headerTitle={() => emptyDraft.activeGlobal() ? "Global" : sidebarSelection.sidebarWorkspaceName()}
          homedir={props.homedir}
          mobileSidebarOpen={chrome.mobileSidebarOpen}
          openMobileSidebar={chrome.openMobileSidebar}
          onArchiveSession={props.onArchiveSession}
          onDeleteSession={props.onDeleteSession}
          onDeleteWorkspace={props.onDeleteWorkspace}
          onHelp={props.onHelp}
          onNewPage={props.onNewPage}
          onNewProject={props.onNewProject}
          onNewSession={props.onNewSession}
          onNewTerminal={props.onNewTerminal}
          onOpenMarketplace={props.onOpenMarketplace}
          onOpenWorkGraph={props.onOpenWorkGraph}
          onRemoveProject={props.onRemoveProject}
          onSettings={props.onSettings}
          onSessionSelect={props.onSessionSelect}
          onTabSelect={props.onTabSelect}
          onWorkspaceSelect={props.onWorkspaceSelect}
          projects={props.projects}
          onRailCancelCollapse={shellLayout.cancelRailCollapse}
          onRailLockChange={shellLayout.lockRail}
          onRailTrackPosition={shellLayout.trackRailPosition}
          sidebarEligible={emptyDraft.sidebarEligible}
          sidebarExpanded={sidebarExpanded}
          sidebarHidden={sidebarHidden}
          sidebarPinned={sidebarPinned}
          sidebarWidth={sidebarWidth}
          onSidebarResize={resizeSidebar}
          onSidebarResizeEnd={commitSidebarResize}
          onSidebarMouseLeave={handleSidebarMouseLeave}
          onToggleSidebar={toggleSidebar}
          trafficLightPad={chrome.trafficLightPad}
        />
        </nav>
        <RailWorkbenchShell
          activeGlobal={emptyDraft.activeGlobal}
          canUseDocuments={props.canUseDocuments}
          canUseTerminal={workbenchController.canUseTerminal}
          emptyDraftDirectory={emptyDraft.emptyDraftDirectory}
          focusedPanelTarget={workbenchController.focusedPanelTarget}
          hasWorkspacePanelTarget={workbenchController.hasWorkspacePanelTarget}
          onCloseSurface={workbenchController.closeSurface}
          onNewPage={props.onNewPage}
          onNewProject={props.onNewProject}
          onNewSession={workbenchController.createHeaderSession}
          onNewTerminal={workbenchController.createHeaderTerminal}
          onWorkspacePanelFloatingChromeRef={workbenchController.registerWorkspacePanelFloatingChrome}
          onWorkspacePanelShellRef={workbenchController.registerWorkspacePanelShell}
          onWorkspacePanelWorkbenchColumnRef={workbenchController.registerWorkspacePanelWorkbenchColumn}
          onWorkspacePanelWidthChange={shellLayout.setWorkspacePanelWidth}
          onSelectSurface={workbenchController.selectSurface}
          onSettings={props.onSettings}
          onShowSidebar={showSidebar}
          onSidebarHotZoneEnter={handleSidebarHotZoneEnter}
          onToggleWorkspacePanel={toggleWorkspacePanel}
          onToggleWorkspacePanelFullWidth={toggleWorkspacePanelFullWidth}
          projectsCount={() => props.projects.length}
          sidebarPinned={sidebarPinned}
          state={claxedoState}
          switcherItems={workbenchController.switcherItems}
          toggleFocusedWorkspaceNavigator={workbenchController.toggleFocusedWorkspaceNavigator}
          toggleFocusedWorkspaceReview={toggleWorkspacePanel}
          topBarRight={props.topBarRight}
          trafficLightPad={chrome.trafficLightPad}
          workspacePanelBridgeChromeVisible={workbenchController.workspacePanelBridgeChromeVisible}
          workspacePanelForFocusedTarget={workbenchController.workspacePanelForFocusedTarget}
          workspacePanelFullWidth={workspacePanelFullWidth}
          workspacePanelMode={workbenchController.workspacePanelMode}
          workspacePanelNavigator={workbenchController.workspacePanelNavigator}
          workspacePanelVisualOpen={workspacePanelOpen}
          workspacePanelWidth={workspacePanelWidth}
        >
          {props.children}
        </RailWorkbenchShell>
      </div>
    </div>
  )
}

export function AppShellLayout(props: AppShellLayoutProps) {
  return <AppShellLayoutBody {...props} />
}
