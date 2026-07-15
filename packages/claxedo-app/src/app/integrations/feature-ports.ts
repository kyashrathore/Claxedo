import { configureSessionAppPorts } from "@/features/session/app-ports"
import { configureTerminalAppPorts } from "@/features/terminal/app-ports"
import { configureSettingsAppPorts } from "@/features/settings/app-ports"
import { configureDocumentsAppPorts } from "@/features/documents/app-ports"
import { configureReviewAppPorts } from "@/features/review/app-ports"
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
import * as Events from "@/app/integrations/claxedo-events"
import * as Config from "@/app/providers/config"
import * as QueryOptions from "@/app/integrations/sync/query-options"
import * as GlobalBootstrap from "@/app/integrations/sync/global-bootstrap"
import * as State from "@/app/workbench/state"
import * as StatePayload from "@/app/workbench/state/session-content-payload"
import * as PaneID from "@/app/workbench/context/pane-id"
import * as Workbench from "@/app/workbench/workbench"
import * as WorkspaceQuery from "@/features/workspaces/data/use-workspace-query"
import * as WorkspaceConnection from "@/features/workspaces/data/workspace-connection"
import * as WorkspaceGateModule from "@/features/workspaces/data/workspace-gate"
import * as WorkspaceScope from "@/features/workspaces/data/workspace-scope"
import * as DirectoryScopeModule from "@/app/workbench/context/directory-scope"
import * as StatusPopoverModule from "@/app/connection/status-popover"
import * as SurfaceStatus from "@/app/workbench/compact-switcher/surface-status"
import * as Navigation from "@/app/workbench/navigation/navigation-row"
import * as LayoutActions from "@/app/workbench/actions/shared"
import * as WorkspaceRecovery from "@/features/workspaces/actions/workspace-recovery"
import * as Marketplace from "@/features/extensions/marketplace/api"
import * as SessionScope from "@/features/session/ui/components/session-pane-scope"
import * as ConnectIntegration from "@/app/dialogs/connect-integration"
import * as LinkModule from "@/app/controls/link"
import * as SessionModels from "@/features/session/providers/models"
import * as ConnectProvider from "@/app/dialogs/connect-provider"
import * as SelectProvider from "@/app/dialogs/select-provider"
import * as CustomProvider from "@/app/dialogs/custom-provider"
import * as SessionSync from "@/features/session/providers/session-sync"
import * as MarkdownTab from "@/app/workbench/lib/open-markdown-page-tab"
import * as ProjectEnsure from "@/features/workspaces/data/query/project-ensure"
import * as SurfaceRoute from "@/app/workbench/state/surface-route"
import * as Prompt from "@/features/session/providers/prompt"
import * as PanePreferences from "@/features/session/preferences/pane"
import * as ReleaseNotes from "@/app/dialogs/release-notes"
import * as TerminalFit from "@/features/terminal/workbench/terminal-fit"
import * as Dialogs from "@/app/dialogs"
import * as DialogSettingsModule from "@/app/dialogs/settings"
import * as DialogSelectDirectoryModule from "@/app/dialogs/select-directory"
import * as SessionQueries from "@/features/session/data/sync/queries"
import * as SessionCache from "@/features/session/data/sync/directory-session-cache"
import * as CloudStartup from "@/features/session/ui/components/cloud-startup-view"
import * as DocWorkGraph from "@/app/integrations/doc-workgraph"

configureSessionAppPorts({
  useSDK: SDK.useSDK,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  useLayout: Layout.useLayout,
  useServer: Server.useServer,
  formatKeybind: Command.formatKeybind,
  useCommand: Command.useCommand,
  useFile: FileContext.useFile,
  useProviders: Providers.useProviders,
  useGlobalSync: GlobalSync.useGlobalSync,
  useTerminal: Terminal.useTerminal,
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useConfigOptional: Config.useConfigOptional,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  useGlobalBootstrapActions: GlobalBootstrap.useGlobalBootstrapActions,
  useClaxedoState: State.useClaxedoState,
  sessionContentPayload: StatePayload.sessionContentPayload,
  usePaneId: PaneID.usePaneId,
  PaneIdProvider: PaneID.PaneIdProvider,
  workbenchDrag: Workbench.workbenchDrag,
  useWorkspaceQuery: WorkspaceQuery.useWorkspaceQuery,
  isWorkspaceReady: WorkspaceConnection.isWorkspaceReady,
  workspacePlacement: WorkspaceConnection.workspacePlacement,
  WorkspaceGate: WorkspaceGateModule.WorkspaceGate,
  useWorkspaceScopeRegistryOptional: WorkspaceScope.useWorkspaceScopeRegistryOptional,
  DirectoryScope: DirectoryScopeModule.DirectoryScope,
  StatusPopover: StatusPopoverModule.StatusPopover,
  terminalSurfaceStatus: SurfaceStatus.terminalSurfaceStatus,
  NavigationRow: Navigation.NavigationRow,
  NavigationStatusDot: Navigation.NavigationStatusDot,
  ensureActionDirectorySessionCache: LayoutActions.ensureDirectorySessionCache,
  findProjectForWorkspace: LayoutActions.findProjectForWorkspace,
  findWorkspaceForDirectory: LayoutActions.findWorkspaceForDirectory,
  message: LayoutActions.message,
  sessionRefForActionWorkspace: LayoutActions.sessionRefForActionWorkspace,
  recoverMissingWorkspace: WorkspaceRecovery.recoverMissingWorkspace,
  loadManageModelsDialog: () => import("@/app/dialogs/manage-models"),
  loadSelectProviderDialog: () => import("@/app/dialogs/select-provider"),
  loadConnectProviderDialog: () => import("@/app/dialogs/connect-provider"),
  filterMcpCatalogEntries: Marketplace.filterMcpCatalogEntries,
  installDisabledReasonForEntry: Marketplace.installDisabledReasonForEntry,
  installMcpDialogEntry: Marketplace.installMcpDialogEntry,
  isEntryInstalled: Marketplace.isEntryInstalled,
  loadMcpDialogData: Marketplace.loadMcpDialogData,
  sourceLabel: Marketplace.sourceLabel,
  targetLabel: Marketplace.targetLabel,
  uninstallMcpDialogEntry: Marketplace.uninstallMcpDialogEntry,
})

configureTerminalAppPorts({
  useSDK: SDK.useSDK,
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useClaxedoState: State.useClaxedoState,
  SessionPaneScope: SessionScope.SessionPaneScope,
  NavigationRow: Navigation.NavigationRow,
  NavigationStatusDot: Navigation.NavigationStatusDot,
  workspacePlacement: WorkspaceConnection.workspacePlacement,
  recoverMissingWorkspace: WorkspaceRecovery.recoverMissingWorkspace,
})

configureSettingsAppPorts({
  useProviders: Providers.useProviders,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  DialogConnectProvider: ConnectProvider.DialogConnectProvider,
  DialogSelectProvider: SelectProvider.DialogSelectProvider,
  DialogCustomProvider: CustomProvider.DialogCustomProvider,
  useModels: SessionModels.useModels,
  formatKeybind: Command.formatKeybind,
  parseKeybind: Command.parseKeybind,
  useCommand: Command.useCommand,
  DialogConnectIntegration: ConnectIntegration.DialogConnectIntegration,
  Link: LinkModule.Link,
})

configureDocumentsAppPorts({
  useSDK: SDK.useSDK,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  useSessionSyncOptional: SessionSync.useSessionSyncOptional,
  useClaxedoState: State.useClaxedoState,
  markdownPathFromHref: MarkdownTab.markdownPathFromHref,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  ensureLocalProject: ProjectEnsure.ensureLocalProject,
  surfaceRoute: SurfaceRoute.surfaceRoute,
  SessionPaneScope: SessionScope.SessionPaneScope,
  turnDocumentRevisionIntoWork: DocWorkGraph.turnDocumentRevisionIntoWork,
})

configureReviewAppPorts({
  useFile: FileContext.useFile,
  usePrompt: Prompt.usePrompt,
  useSDK: SDK.useSDK,
  createPanePreferences: PanePreferences.createPanePreferences,
  reviewModePreferenceScope: PanePreferences.reviewModePreferenceScope,
  DialogReleaseNotes: ReleaseNotes.DialogReleaseNotes,
})

configureWorkspacesAppPorts({
  useServer: Server.useServer,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  getAvatarColors: Layout.getAvatarColors,
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useClaxedoEvents: Events.useClaxedoEvents,
  useConfigOptional: Config.useConfigOptional,
  emitTerminalFit: TerminalFit.emitTerminalFit,
  DialogRecoverWorkspace: Dialogs.DialogRecoverWorkspace,
  DialogDeleteWorkspace: Dialogs.DialogDeleteWorkspace,
  DialogSettings: DialogSettingsModule.DialogSettings,
  DialogSelectDirectory: DialogSelectDirectoryModule.DialogSelectDirectory,
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
  isForbiddenConnectionError: CloudStartup.isForbiddenConnectionError,
})
