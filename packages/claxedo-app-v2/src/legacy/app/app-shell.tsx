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

import { sessionPerf } from "@/platform/performance/session-perf"
import { markRendererPhase } from "@/platform/performance/renderer-trace"
import "./styles/app-shell.css"
import { createEffect, createMemo, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { AppShellLayout } from "./app-shell-layout"

import { PromptHarnessControllersProvider } from "../features/session/composer/ui/harness-controller"
import { ModelStoreRegistryProvider } from "../features/session/providers/models"
import { SettingsSurfaceProvider, useSettingsSurface } from "@/features/settings/settings-surface"
import { SettingsScopeProvider } from "@/features/settings/scope/settings-scope"
import { WorkspaceScopeHost } from "../features/workspaces/data/workspace-scope"
import { ClaxedoRouteStateBridge } from "./workbench/state/route-bridge"
import { routeSuppressesEmptyDraftSession } from "./workbench/state/provider"
import { useClaxedoAppShellCommands } from "./app-shell-commands"
import { applySessionAccessRevocation, useAppShellRouteSync, applyStaleWorkspaceSweep } from "./app-shell-route-sync"
import { useAppShellState } from "./app-shell-state"
import { useAppShellActions } from "./app-shell-actions"
import {
  buildProcessDiagnosticsContext,
  useFocusedSessionRenderMetrics,
} from "./integrations/process-diagnostics-context"
import { reviewWorkspaceActiveTab } from "@/features/review/ui/review-workspace-active-tab"
import { resolveProductUiFlags } from "@/app/composition/product-ui-flags"
import { useGlobalSessionAccessRevocations } from "@/app/integrations/sync/global-sync-boundary"

traceModuleEvaluation("runtime.appShellModuleEvaluated")

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
  useGlobalSessionAccessRevocations((event) => {
    applySessionAccessRevocation({
      ...event,
      activeSurfaceId: shell.state.wb.selectors.focusedContent,
      surfaces: shell.state.meta.all,
      closeContent: shell.state.layout.closeContent,
      navigate,
    })
  })
  createEffect(() => {
    const swept = applyStaleWorkspaceSweep({
      inventoryReady: shell.inventoryReady(),
      inventory: shell.inventory(),
      activeSurfaceId: shell.state.wb.selectors.focusedContent,
      surfaces: shell.state.meta.all,
      closeContent: shell.state.layout.closeContent,
      navigate,
    })
    if (swept.length > 0) {
      sessionPerf.event("shell.stale-workspace-sweep", {
        swept: swept.join(","),
        inventory: shell.inventory().map((project) => project.worktree ?? "").join("|"),
        surfaces: shell.state.meta.all().map((surface) => `${surface.type}:${surface.directory ?? ""}`).join("|"),
      })
    }
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
    handleProjectCreated,
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
    handleOpenTasks,
  } = useAppShellActions({
    shell,
    params,
    navigate,
  })

  const settingsSurface = useSettingsSurface()

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
        onProjectCreated={handleProjectCreated}
        onSettings={() => settingsSurface.open()}
        onUsage={handleUsage}
        onHelp={handleHelp}
        onOpenMarketplace={handleOpenMarketplace}
        onOpenTasks={handleOpenTasks}
        documentNavigationEnabled={productUi().documentNavigation}
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
      <ClaxedoRouteStateBridge>
        <PromptHarnessControllersProvider>
          {/* One persisted model document per (server, workspace), for the
              shell's lifetime. A pane's composer and the Settings Models page
              are routinely open on the same workspace at once and edit that one
              document, so they must hold the same record rather than a copy
              each. Mounted here, above every pane and above the dialog host's
              caller, so both find it. */}
          {/* Above the shell body so the rail and the workbench column read
              one answer: settings replaces what each of them draws, together. */}
          <SettingsSurfaceProvider>
            {/* The scope is derived state over the projects query the shell
                already runs, and BOTH halves of settings read it — the rail's
                nav and the workbench column — so it is mounted once here
                rather than inside either of them. */}
            <SettingsScopeProvider>
              <ModelStoreRegistryProvider>
                <ClaxedoAppShellContent>{props.children}</ClaxedoAppShellContent>
              </ModelStoreRegistryProvider>
            </SettingsScopeProvider>
          </SettingsSurfaceProvider>
        </PromptHarnessControllersProvider>
      </ClaxedoRouteStateBridge>
    </>
  )
}

function traceModuleEvaluation(name: string) {
  markRendererPhase(name)
}
