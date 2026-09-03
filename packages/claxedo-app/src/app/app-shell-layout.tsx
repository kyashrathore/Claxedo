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
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  type ParentProps,
  type JSX,
} from "solid-js"
import { lazyDialog } from "@/lib/lazy-dialog"
import { useClaxedoState, type ContentMeta } from "./workbench/state/index"
import type { ProjectItem } from "./workbench/rail/domain-types"
import { emitTerminalFit } from "../features/terminal/workbench/terminal-fit"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useOptionalTerminal } from "@/features/terminal/providers/provider"
import { usePermission } from "@/features/session/providers/permission"
import { useCommand } from "@/app/providers/command"
import { useServer } from "@/app/connection/server"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useRailKeyboardController } from "./workbench/rail/rail-keyboard-controller"
import {
  closeFocusedPaneFromShortcut,
  numberedSurfaceShortcutHints,
  sidebarHiddenForCloseShortcut,
} from "./workbench/rail/rail-keyboard-shortcuts"
import { useRailEmptyDraftController } from "./workbench/rail/rail-empty-draft-controller"
import { useRailShellChromeState } from "./workbench/rail/rail-shell-chrome-state"
import { isNarrowViewport } from "./workbench/workbench/index"
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
import { warmConversationMemorySnapshot } from "../features/session/conversation/conversation-registry"
import {
  TerminalWorkspaceProvisioningProvider,
  type TerminalWorkspaceProvisioning,
} from "./workbench/terminal/terminal-workspace-provisioning"
import { resolveAppShellNavigationActions } from "./app-shell-navigation"

/** See the note on the same alias in `workbench/terminal/terminal-new-view.tsx`. */
type WorkspaceDirectoryRef = string
import "./styles/ui-overrides.css"

const RailSidebarShell = lazy(() =>
  import("./workbench/rail/rail-sidebar-shell").then((module) => ({
    default: module.RailSidebarShell,
  })),
)
const RailWorkbenchShell = lazy(() =>
  import("./workbench/rail/rail-workbench-shell").then((module) => ({
    default: module.RailWorkbenchShell,
  })),
)
const DialogProcessDiagnostics = lazyDialog(() =>
  import("../features/processes/ui/dialog-process-diagnostics").then((module) => ({
    default: module.DialogProcessDiagnostics,
  })),
)

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
  activeWorkspaceRouteId?: string

  /**
   * Currently active session ID
   */
  activeSessionId?: string
  globalChatEnabled?: boolean
  canUseDocuments?: boolean
  documentNavigationEnabled?: boolean

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
  onUsage?: () => void

  /**
   * Callback to open help
   */
  onHelp?: () => void

  /**
   * Callback to open the Marketplace as an in-workbench tab.
   */
  onOpenMarketplace?: () => void

  /**
   * Callback to create a new session. When no workspace is selected yet,
   * callers may pass `undefined` to create an unattached draft first.
   */
  onNewSession?: (workspaceDir?: string, paneId?: string, workspaceRouteId?: string) => void
  suppressEmptyDraftSession?: boolean
  onDeleteSession?: (session: import("./workbench/rail/domain-types").SessionItem) => void
  onArchiveSession?: (session: import("./workbench/rail/domain-types").SessionItem, nextSessionId?: string) => boolean | Promise<boolean>
  onDeleteWorkspace?: (workspace: import("./workbench/rail/domain-types").WorkspaceItem) => void
  onRemoveProject?: (project: import("./workbench/rail/domain-types").ProjectItem) => void

  /**
   * Callback to create a new terminal
   * @param workspaceDir - The workspace directory to create the terminal in
   * @param command - Optional command to run in the terminal (e.g., "claude --dangerously-skip-permissions")
   * @param title - Optional title for the terminal surface (e.g., "Claude", "Codex")
   */
  onNewTerminal?: (workspaceDir: string, command?: string, title?: string, paneId?: string, workspaceRouteId?: string) => void

  /**
   * Provision a workspace for the project owning `workspaceDir` and resolve to
   * the created directory, without opening anything in it. Supplied to the
   * terminal creator (which opens a terminal there itself) through context,
   * because the creator renders inside a pane rather than in the rail's prop
   * drill path.
   */
  onCreateWorkspace?: (input: {
    directory: WorkspaceDirectoryRef
    kind: "local" | "cloud"
  }) => Promise<{ directory: WorkspaceDirectoryRef; workspaceId: string } | undefined>

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
  const isolationStage = window.__OPENCODE__?.startupIsolationStage
  const [sidebarMounted, setSidebarMounted] = createSignal(false)
  let sidebarMountFrame: number | undefined
  onMount(() => {
    sidebarMountFrame = requestAnimationFrame(() => {
      sidebarMountFrame = requestAnimationFrame(() => {
        sidebarMountFrame = undefined
        const trace = window.__claxedoPerfTrace === true
          ? performance.now()
          : undefined
        setSidebarMounted(true)
        if (trace !== undefined) {
          const phases = window.__claxedoPerfRendererPhases
          if (Array.isArray(phases)) phases.push({ name: "shell.sidebarMounted", durationMs: performance.now() - trace })
        }
      })
    })
  })
  onCleanup(() => {
    if (sidebarMountFrame !== undefined) cancelAnimationFrame(sidebarMountFrame)
  })
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
    activeWorkspaceRouteId: () => props.activeWorkspaceRouteId,
    autoResponds: (request, workspaceDir) => permission.autoResponds(request, workspaceDir),
    canUseDocuments: () => props.canUseDocuments === true,
    closeTerminal: (terminalId) => terminal?.close(terminalId),
    emptyDraftDirectory: emptyDraft.emptyDraftDirectory,
    // On a global surface (Marketplace, Global chat) nothing is
    // focused on a workspace, so the terminal creator would have no directory to
    // open against. Seed it with the active one, else the first project — the
    // creator shows the choice as a chip and lets the user change it.
    fallbackWorkspaceDir: () => props.activeDirectory ?? props.projects[0]?.worktree,
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
  const productNavigation = () => resolveAppShellNavigationActions({
    documentNavigationEnabled: props.documentNavigationEnabled,
    onNewPage: props.onNewPage,
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
  const openDiagnostics = () => {
    const returnFocus = document.querySelector<HTMLElement>("[data-testid='rail-account-trigger']")
    void dialog.show(
      () => <DialogProcessDiagnostics warmSessions={warmConversationMemorySnapshot} />,
      () => {
        // The account menu item is removed before the dialog closes. Restore
        // focus to the same durable trigger Usage uses after Kobalte finishes
        // its own close microtask.
        setTimeout(() => {
          if (returnFocus?.isConnected) returnFocus.focus()
        }, 0)
      },
    )
  }
  const openLocalDiagnostics = platform.processDiagnostics ? openDiagnostics : undefined
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
  useRailKeyboardController({
    state: claxedoState,
    command,
    dialog,
    platform,
    // mod+<n> follows the tab strip the user is looking at (the same
    // switcherItems the header renders), not the MRU recency stack.
    surfaceOrder: () => workbenchController.switcherItems().map((item) => item.contentId),
    toggleSidebar,
  })

  function workspacePanelWidth() {
    return shellLayout.workspacePanelWidth()
  }

  const terminalWorkspaceProvisioning: TerminalWorkspaceProvisioning = {
    createWorkspace: async (input) => (await props.onCreateWorkspace?.(input)) ?? undefined,
  }
  return (
    <TerminalWorkspaceProvisioningProvider value={terminalWorkspaceProvisioning}>
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
        <Show
          when={sidebarMounted()}
          fallback={
            <aside
              aria-hidden="true"
              data-testid="rail-sidebar-progressive-placeholder"
              class="shrink-0 bg-background-base"
              style={{ width: `${sidebarWidth()}px` }}
            />
          }
        >
          <RailSidebarShell
          activeGlobal={emptyDraft.activeGlobal}
          activeProjectId={props.activeProjectId}
          activeSessionId={props.activeSessionId}
          activeDirectory={props.activeDirectory}
          activeWorkspaceRouteId={props.activeWorkspaceRouteId}
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
          onNewPage={productNavigation().onNewPage}
          onNewProject={props.onNewProject}
          onDiagnostics={openLocalDiagnostics}
          onNewSession={props.onNewSession}
          onNewTerminal={props.onNewTerminal}
          onOpenMarketplace={props.onOpenMarketplace}
          onRemoveProject={props.onRemoveProject}
          onSettings={props.onSettings}
          onUsage={props.onUsage}
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
        </Show>
        </nav>
        {isolationStage === "sidebar" ? (
          <main
            data-testid="startup-isolation-sidebar"
            class="flex flex-1 bg-background-stronger"
          />
        ) : (
        <RailWorkbenchShell
          activeGlobal={emptyDraft.activeGlobal}
          canUseDocuments={props.canUseDocuments}
          canCreateTerminal={workbenchController.canCreateTerminal}
          emptyDraftDirectory={emptyDraft.emptyDraftDirectory}
          focusedPanelTarget={workbenchController.focusedPanelTarget}
          hasWorkspacePanelTarget={workbenchController.hasWorkspacePanelTarget}
          onCloseFocusedPane={(paneId, contentId) => closeFocusedPaneFromShortcut({
            sidebarHidden: sidebarHiddenForCloseShortcut({
              narrowViewport: isNarrowViewport(),
              mobileSidebarOpen: chrome.mobileSidebarOpen(),
              desktopSidebarHidden: sidebarHidden(),
            }),
            paneId,
            contentId,
            closeSurface: workbenchController.closeSurface,
            closePane: (id) => claxedoState.layout.closePane(id, { destroyContent: false }),
          })}
          onCloseSurface={workbenchController.closeSurface}
          onNewPage={productNavigation().onNewPage}
          onNewProject={props.onNewProject}
          onDiagnostics={openLocalDiagnostics}
          onNewSession={workbenchController.createHeaderSession}
          onNewTerminalDraft={workbenchController.createHeaderTerminalDraft}
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
          surfaceShortcutHints={() => numberedSurfaceShortcutHints(command)}
          switcherItems={workbenchController.switcherItems}
          toggleFocusedWorkspaceNavigator={workbenchController.toggleFocusedWorkspaceNavigator}
          toggleFocusedWorkspaceReview={toggleWorkspacePanel}
          topBarRight={props.topBarRight}
          trafficLightPad={chrome.trafficLightPad}
          workspacePanelBridgeChromeVisible={workbenchController.workspacePanelBridgeChromeVisible}
          workspacePanelForFocusedTarget={workbenchController.workspacePanelForFocusedTarget}
          workspacePanelFullWidth={workspacePanelFullWidth}
          workspacePanelMode={workbenchController.workspacePanelMode}
          workspacePanelMounted={workbenchController.workspacePanelMounted}
          workspacePanelNavigator={workbenchController.workspacePanelNavigator}
          workspacePanelVisualOpen={workspacePanelOpen}
          workspacePanelWidth={workspacePanelWidth}
          mountWorkspacePanel={isolationStage !== "timeline"}
        >
          {props.children}
        </RailWorkbenchShell>
        )}
      </div>
    </div>
    </TerminalWorkspaceProvisioningProvider>
  )
}

export function AppShellLayout(props: AppShellLayoutProps) {
  if (window.__OPENCODE__?.startupIsolationStage === "shell") {
    return (
      <div
        data-testid="startup-isolation-shell"
        class="size-full bg-background-base"
      />
    )
  }
  return <AppShellLayoutBody {...props} />
}
