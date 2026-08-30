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

import { markRendererPhase } from "@/platform/performance/renderer-trace"
import "./styles/app-shell.css"
import { createEffect, createMemo, lazy, onCleanup, onMount, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { AppShellLayout } from "./app-shell-layout"

import { isDemoMode } from "@/platform/api/api"
import { PromptHarnessControllersProvider } from "../features/session/composer/ui/harness-controller"
import { WorkspaceScopeHost } from "../features/workspaces/data/workspace-scope"
import { ClaxedoRouteStateBridge } from "./workbench/state/route-bridge"
import { routeSuppressesEmptyDraftSession } from "./workbench/state/provider"
import { useClaxedoAppShellCommands } from "./app-shell-commands"
import { applySessionAccessRevocation, useAppShellRouteSync } from "./app-shell-route-sync"
import { useAppShellState } from "./app-shell-state"
import { useAppShellActions } from "./app-shell-actions"
import {
  buildProcessDiagnosticsContext,
  useFocusedSessionRenderMetrics,
} from "./integrations/process-diagnostics-context"
import { reviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { installUsageOutboxWakeups } from "@/features/usage/data/usage-api"
import { resolveProductUiFlags } from "@/app/composition/product-ui-flags"
import { useSessionAccessRevocations } from "@/app/integrations/sync/global-readiness"

const DemoTourController = __DEMO_ENABLED__
  ? lazy(() => import("./demo/tour-controller").then((m) => ({ default: m.DemoTourController })))
  : () => null

traceModuleEvaluation("runtime.appShellModuleEvaluated")

/**
 * ClaxedoAppShellContent - The actual layout content
 */
function ClaxedoAppShellContent(props: ParentProps) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  onMount(() => onCleanup(installUsageOutboxWakeups()))
  const shell = useAppShellState({
    params,
    pathname: () => location.pathname,
  })
  useSessionAccessRevocations((event) => {
    applySessionAccessRevocation({
      ...event,
      activeSurfaceId: shell.state.wb.selectors.focusedContent,
      surfaces: shell.state.meta.all,
      closeContent: shell.state.layout.closeContent,
      navigate,
    })
  })
  const productUi = createMemo(() => resolveProductUiFlags(shell.config))
  const diagnosticSession = createMemo(() => {
    const panes = shell.state.wb.selectors.visiblePanes()
    const focused = shell.state.wb.state.focusedPaneId
    return [...panes].sort((left, right) => left.id === focused ? -1 : right.id === focused ? 1 : 0)
      .flatMap((pane) => {
        const content = pane.contentId ? shell.state.meta.get(pane.contentId) : undefined
        return content?.type === "session" && content.sessionId
          ? [{ paneId: pane.id, sessionId: content.sessionId }]
          : []
      })[0]
  })
  const sessionRender = useFocusedSessionRenderMetrics({
    enabled: () => !!shell.platform.processDiagnostics,
    paneId: () => diagnosticSession()?.paneId,
    sessionId: () => diagnosticSession()?.sessionId,
  })

  createEffect(() => {
    void shell.platform.processDiagnostics?.recordContext(buildProcessDiagnosticsContext({
      pathname: location.pathname,
      activeSessionId: shell.activeSessionId(),
      focusedPaneId: shell.state.wb.state.focusedPaneId ?? undefined,
      panes: shell.state.wb.selectors.visiblePanes(),
      contentIds: shell.state.wb.state.contentIds,
      content: shell.state.meta.get,
      workspacePanel: shell.state.workspacePanel.state(),
      workspacePanelTab: reviewWorkspaceActiveTab()?.kind,
      sessionRender: sessionRender(),
    }))
  })
  useClaxedoAppShellCommands({
    state: shell.state,
    activeDirectory: shell.activeDirectory,
  })

  const { handleTabClose } = useAppShellRouteSync({
    activeSurface: shell.activeSurface,
    activeDirectory: shell.activeDirectory,
    projects: shell.projects,
    findSurface: shell.state.meta.find,
    navigate,
    params,
    hash: () => location.hash,
    pathname: () => location.pathname,
    routeDirectory: shell.routeDirectory,
    routeId: shell.routeId,
    search: () => location.search,
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
    handleSettings,
    handleUsage,
    handleHelp,
    handleNewSession,
    handleDeleteSession,
    handleArchiveSession,
    handleDeleteWorkspace,
    handleRemoveProject,
    handleNewTerminal,
    createWorkspaceDirectory,
    handleNewPage,
    handleTabSelect,
    handleOpenMarketplace,
    handleOpenWorkGraph,
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
        activeDirectory={shell.activeDirectory()}
        activeWorkspaceRouteId={shell.activeWorkspaceRouteId()}
        activeSessionId={shell.activeSessionId()}
        globalChatEnabled={shell.globalChat()}
        homedir={shell.pathQuery.data?.home}
        suppressEmptyDraftSession={routeSuppressesEmptyDraftSession(location.pathname)}
        onWorkspaceSelect={handleWorkspaceSelect}
        onSessionSelect={handleSessionSelect}
        onNewProject={handleNewProject}
        onSettings={handleSettings}
        onUsage={handleUsage}
        onHelp={handleHelp}
        onOpenMarketplace={handleOpenMarketplace}
        onOpenWorkGraph={handleOpenWorkGraph}
        documentNavigationEnabled={productUi().documentNavigation}
        workGraphNavigationEnabled={productUi().workGraphNavigation}
        canUseDocuments={shell.canUseDocuments()}
        onNewSession={handleNewSession}
        onNewTerminal={handleNewTerminal}
        onCreateWorkspace={createWorkspaceDirectory}
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
export function ClaxedoAppShellInner(props: ParentProps) {
  return (
    <>
      {isDemoMode() && <DemoTourController />}
      <ClaxedoRouteStateBridge>
        <PromptHarnessControllersProvider>
          <ClaxedoAppShellContent>{props.children}</ClaxedoAppShellContent>
        </PromptHarnessControllersProvider>
      </ClaxedoRouteStateBridge>
    </>
  )
}

function traceModuleEvaluation(name: string) {
  markRendererPhase(name)
}
