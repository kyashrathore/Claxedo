import { rendererTraceEnabled } from "@/platform/performance/renderer-trace"
import { checkServerHealthCached } from "@/app/connection/server-health"
import { ProjectCreateForm } from "@/features/workspaces/ui/project-create-form"
import { configureSessionAppPorts } from "@/features/session/app-ports"
import { configureDocumentsAppPorts } from "@/features/documents/app-ports"
import { configureWorkspacesAppPorts } from "@/features/workspaces/app-ports"
import * as SDK from "@/app/providers/sdk/sdk"
import * as GlobalSDK from "@/app/providers/global-sdk/provider"
import * as Layout from "@/app/providers/layout"
import * as Server from "@/app/connection/server"
import * as Command from "@/app/providers/command"
import * as FileContext from "@/app/providers/file"
import * as Providers from "@/app/providers/use-providers"
import * as GlobalSync from "@/app/providers/global-sync/provider"
import * as Terminal from "@/features/terminal/providers/provider"
import * as ProcessClient from "@/features/processes/data/client"
import * as Events from "@/app/integrations/claxedo-events"
import * as Config from "@/app/providers/config"
import * as QueryOptions from "@/app/integrations/sync/query-options"
import * as GlobalBootstrap from "@/app/integrations/sync/global-bootstrap"
import * as State from "@/app/workbench/state"
import * as StatePayload from "@/app/workbench/state/session-content-payload"
import * as PaneID from "@/app/workbench/context/pane-id"
import * as PaneCtxModule from "@/app/workbench/context/pane-ctx"
import * as WorkspaceQuery from "@/features/workspaces/data/use-workspace-query"
import * as WorkspaceConnection from "@/features/workspaces/data/workspace-connection"
import * as WorkspaceCreate from "@/features/workspaces/data/workspace-create-api"
import * as WorkspaceGateModule from "@/features/workspaces/data/workspace-gate"
import * as WorkspaceScope from "@/features/workspaces/data/workspace-scope"
import * as CodeHost from "@/features/onboarding/code-host-api"
import * as DirectoryScopeModule from "@/app/workbench/context/directory-scope"
import * as SurfaceStatus from "@/app/workbench/compact-switcher/surface-status"
import * as Navigation from "@/app/workbench/navigation/navigation-row"
import * as LayoutActions from "@/app/workbench/actions/shared"
import * as WorkspaceRecovery from "@/features/workspaces/actions/workspace-recovery"
import * as SessionScope from "@/features/session/ui/components/session-pane-scope"
import * as SessionSync from "@/features/session/providers/session-sync"
import * as MarkdownTab from "@/app/workbench/lib/open-markdown-page-tab"
import * as ProjectEnsure from "@/features/workspaces/data/query/project-ensure"
import * as SurfaceRoute from "@/app/workbench/state/surface-route"
import * as TerminalFit from "@/features/terminal/workbench/terminal-fit"
import * as SessionQueries from "@/features/session/data/sync/queries"
import * as SessionCache from "@/features/session/data/sync/directory-session-cache"
import * as CloudStartup from "@/features/session/ui/components/cloud-startup-view"
import * as DocumentMentions from "@/app/integrations/document-mentions"
import * as RailGitRemote from "@/app/workbench/rail/rail-git-remote"
import { useOnboardingFunnel } from "./onboarding-funnel"
import { lazyDialog } from "@/lib/lazy-dialog"

export const DialogConnectIntegration = lazyDialog(() =>
  import("@/app/dialogs/connect-integration").then((module) => ({ default: module.DialogConnectIntegration })),
)
const DialogRecoverWorkspace = lazyDialog(() =>
  import("@/features/workspaces/ui/dialogs/recover-workspace-dialog").then((module) => ({
    default: module.DialogRecoverWorkspace,
  })),
)
const DialogDeleteWorkspace = lazyDialog(() =>
  import("@/features/workspaces/ui/dialogs/delete-workspace-dialog").then((module) => ({
    default: module.DialogDeleteWorkspace,
  })),
)
const DialogSelectDirectory = lazyDialog(() =>
  import("@/app/dialogs/select-directory").then((module) => ({ default: module.DialogSelectDirectory })),
)
const DialogSelectMcp = lazyDialog(() =>
  import("@/app/dialogs/select-mcp").then((module) => ({ default: module.DialogSelectMcp })),
)


configureSessionAppPorts({
  useSDK: SDK.useSDK,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  useLayout: Layout.useLayout,
  useServer: Server.useServer,
  checkServerHealth: checkServerHealthCached,
  ProjectCreateForm,
  DialogSelectDirectory,
  DialogSelectMcp,
  formatKeybind: Command.formatKeybind,
  useCommand: Command.useCommand,
  useFile: FileContext.useFile,
  useProviders: Providers.useProviders,
  useGlobalSync: GlobalSync.useGlobalSync,
  useTerminal: Terminal.useTerminal,
  createProcessClient: ProcessClient.createProcessClient,
  parseOwnerRepo: RailGitRemote.parseOwnerRepo,
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useFirstTurnFunnel: useOnboardingFunnel,
  useConfigOptional: Config.useConfigOptional,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  useGlobalBootstrapActions: GlobalBootstrap.useGlobalBootstrapActions,
  useClaxedoState: State.useClaxedoState,
  sessionContentPayload: StatePayload.sessionContentPayload,
  usePaneId: PaneID.usePaneId,
  PaneIdProvider: PaneID.PaneIdProvider,
  usePaneCtx: PaneCtxModule.usePaneCtx,
  useWorkspaceQuery: WorkspaceQuery.useWorkspaceQuery,
  isWorkspaceReady: WorkspaceConnection.isWorkspaceReady,
  workspacePlacement: WorkspaceConnection.workspaceRelayPlacement,
  createCloudWorkspace: WorkspaceCreate.createCloudWorkspace,
  WorkspaceGate: WorkspaceGateModule.WorkspaceGate,
  useWorkspaceScopeRegistryOptional: WorkspaceScope.useWorkspaceScopeRegistryOptional,
  DirectoryScope: DirectoryScopeModule.DirectoryScope,
  terminalSurfaceStatus: SurfaceStatus.terminalSurfaceStatus,
  NavigationRow: Navigation.NavigationRow,
  NavigationStatusMark: Navigation.NavigationStatusMark,
  NavigationRowStatusGutter: Navigation.NavigationRowStatusGutter,
  NavigationRowGlyph: Navigation.NavigationRowGlyph,
  ensureActionDirectorySessionCache: LayoutActions.ensureDirectorySessionCache,
  findProjectForWorkspace: LayoutActions.findProjectForWorkspace,
  findWorkspaceForDirectory: LayoutActions.findWorkspaceForDirectory,
  message: LayoutActions.message,
  sessionRefForActionWorkspace: LayoutActions.sessionRefForActionWorkspace,
  recoverMissingWorkspace: WorkspaceRecovery.recoverMissingWorkspace,
  loadManageModelsDialog: () => import("@/app/dialogs/manage-models"),
  listDocumentMentions: DocumentMentions.listDocumentMentions,
  documentMentionText: DocumentMentions.documentMentionText,
})

configureDocumentsAppPorts({
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useSessionSyncOptional: SessionSync.useSessionSyncOptional,
  useClaxedoState: State.useClaxedoState,
  markdownPathFromHref: MarkdownTab.markdownPathFromHref,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  ensureLocalProject: ProjectEnsure.ensureLocalProject,
  surfaceRoute: SurfaceRoute.surfaceRoute,
  SessionPaneScope: SessionScope.SessionPaneScope,
})

configureWorkspacesAppPorts({
  useServer: Server.useServer,
  checkServerHealth: checkServerHealthCached,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  getAvatarColors: Layout.getAvatarColors,
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useClaxedoEvents: Events.useClaxedoEvents,
  useConfigOptional: Config.useConfigOptional,
  emitTerminalFit: TerminalFit.emitTerminalFit,
  DialogRecoverWorkspace,
  DialogDeleteWorkspace,
  DialogSelectDirectory,
  ensureDirectorySessionCache: LayoutActions.ensureDirectorySessionCache,
  findProjectForWorkspace: LayoutActions.findProjectForWorkspace,
  message: LayoutActions.message,
  missingLocalWorkspace: LayoutActions.missingLocalWorkspace,
  sessionRefForActionWorkspace: LayoutActions.sessionRefForActionWorkspace,
  directorySessionCacheQueryOptions: SessionQueries.directorySessionCacheQueryOptions,
  realDirectory: State.realDirectory,
  useDirectorySessionCacheActions: SessionCache.useDirectorySessionCacheActions,
  CloudStartupView: CloudStartup.CloudStartupView,
  WorkspaceAccessDeniedView: CloudStartup.WorkspaceAccessDeniedView,
  WorkspaceStateShell: CloudStartup.WorkspaceStateShell,
  WorkspaceStateNote: CloudStartup.WorkspaceStateNote,
  WorkspaceStateButton: CloudStartup.WorkspaceStateButton,
  isForbiddenConnectionError: CloudStartup.isForbiddenConnectionError,
  readCodeHostStatus: CodeHost.readCodeHostStatus,
  connectedCodeHosts: CodeHost.connectedCodeHosts,
  connectCodeHost: CodeHost.connectCodeHost,
  readCodeHostAttempt: CodeHost.readCodeHostAttempt,
  listCodeHostRepositories: CodeHost.listCodeHostRepositories,
})

if (rendererTraceEnabled()) {
  performance.mark("runtime.featurePortsModuleEvaluated")
}
