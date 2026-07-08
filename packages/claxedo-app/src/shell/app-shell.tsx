/**
 * ClaxedoAppShell - Custom app shell for Rail + Tab UI
 *
 * This replaces the default Layout when registered via the extension system.
 * It provides the Rail sidebar and Tab bar UI with Project > Workspace > Session hierarchy.
 *
 * Note: the app shell is at app level (outside DirectoryLayout/SDKProvider),
 * so it cannot directly access terminal context. Terminal surface creation is
 * coordinated via claxedo layout state and rendered through multi-pane leaves.
 */

import "../claxedo-ui/claxedo-layout.css"
import { createEffect, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { Toast } from "@opencode-ai/ui/toast"

import { AppShellLayout } from "./app-shell-layout"
import { ClaxedoStateProvider } from "../claxedo-ui/state"

import { isDemoMode } from "../utils/api"
import { lazy } from "solid-js"
import { PromptHarnessControllersProvider } from "../components/prompt-input/harness-controller"
import { WorkspaceScopeHost } from "./workspace/workspace-scope"
import { ClaxedoRouteStateBridge } from "../claxedo-ui/state/route-bridge"
import { useClaxedoAppShellCommands } from "./app-shell-commands"
import { useAppShellRouteSync } from "./app-shell-route-sync"
import { useAppShellState } from "./app-shell-state"
import { useAppShellActions } from "./app-shell-actions"

const DemoTourController = __DEMO_ENABLED__
  ? lazy(() => import("../demo/tour-controller").then((m) => ({ default: m.DemoTourController })))
  : () => null

/**
 * ClaxedoAppShellContent - The actual layout content
 */
function ClaxedoAppShellContent(props: ParentProps) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const shell = useAppShellState({
    params,
    pathname: () => location.pathname,
  })
  useClaxedoAppShellCommands({
    state: shell.state,
    activeWorkspaceId: shell.activeWorkspaceId,
  })

  const { handleTabClose } = useAppShellRouteSync({
    activeSurface: shell.activeSurface,
    activeWorkspaceId: shell.activeWorkspaceId,
    findSurface: shell.state.meta.find,
    navigate,
    params,
    pathname: () => location.pathname,
    routeWorkspaceId: shell.routeWorkspaceId,
    sessionInventory: shell.sessionInventory,
    shellRouteKind: shell.shellRouteKind,
  })

  createEffect(() => {
    shell.autoOpenActiveProject()
  })

  const {
    handleWorkspaceSelect,
    handleSessionSelect,
    handleNewProject,
    handleNewWorkspace,
    handleSettings,
    handleHelp,
    handleNewSession,
    handleDeleteSession,
    handleArchiveSession,
    handleDeleteWorkspace,
    handleRemoveProject,
    handleNewTerminal,
    handleNewPage,
    handleTabSelect,
    handleOpenMarketplace,
  } = useAppShellActions({
    shell,
    params,
    navigate,
  })

  return (
    <WorkspaceScopeHost workspaceIds={shell.openWorkspaceIds}>
      <AppShellLayout
        projects={shell.projects()}
        activeProjectId={shell.activeProjectId()}
        activeWorkspaceId={shell.activeWorkspaceId()}
        activeSessionId={shell.activeSessionId()}
        globalChatEnabled={shell.globalChat()}
        homedir={shell.pathQuery.data?.home}
        suppressEmptyDraftSession={shell.shellRouteKind() === "session" || shell.shellRouteKind() === "workspace" || !!params.id}
        onWorkspaceSelect={handleWorkspaceSelect}
        onSessionSelect={handleSessionSelect}
        onNewProject={handleNewProject}
        onNewWorkspace={handleNewWorkspace}
        onSettings={handleSettings}
        onHelp={handleHelp}
        onOpenMarketplace={handleOpenMarketplace}
        canUsePages={shell.canUsePages()}
        onNewSession={handleNewSession}
        onNewTerminal={handleNewTerminal}
        onNewPage={handleNewPage}
        onTabSelect={handleTabSelect}
        onTabClose={handleTabClose}
        onDeleteSession={handleDeleteSession}
        onArchiveSession={handleArchiveSession}
        onDeleteWorkspace={handleDeleteWorkspace}
        onRemoveProject={handleRemoveProject}
        // titlebar={<Titlebar />}
      >
        {props.children}
      </AppShellLayout>
    </WorkspaceScopeHost>
  )
}

/**
 * ClaxedoAppShell - Main app shell.
 *
 * TerminalProvider stays out of this app-level shell because directory-scoped
 * providers mount under directory-layout/DirectoryScope for each Workbench pane.
 */
export function ClaxedoAppShell(props: ParentProps) {
  return (
    <ClaxedoStateProvider>
      <Toast.Region />
      {isDemoMode() && <DemoTourController />}
      <ClaxedoRouteStateBridge>
        <PromptHarnessControllersProvider>
          <ClaxedoAppShellContent>{props.children}</ClaxedoAppShellContent>
        </PromptHarnessControllersProvider>
      </ClaxedoRouteStateBridge>
    </ClaxedoStateProvider>
  )
}
