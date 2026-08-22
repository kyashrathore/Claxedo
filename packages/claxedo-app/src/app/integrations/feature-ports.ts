import { rendererTraceEnabled } from "@/platform/performance/renderer-trace"
import { configureSessionAppPorts } from "@/features/session/app-ports"
import { configureDocumentsAppPorts } from "@/features/documents/app-ports"
import { configureWorkGraphAppPorts } from "@/features/workgraph/app-ports"
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
import * as SessionSync from "@/features/session/providers/session-sync"
import * as MarkdownTab from "@/app/workbench/lib/open-markdown-page-tab"
import * as ProjectEnsure from "@/features/workspaces/data/query/project-ensure"
import * as SurfaceRoute from "@/app/workbench/state/surface-route"
import * as TerminalFit from "@/features/terminal/workbench/terminal-fit"
import * as SessionQueries from "@/features/session/data/sync/queries"
import * as SessionCache from "@/features/session/data/sync/directory-session-cache"
import * as CloudStartup from "@/features/session/ui/components/cloud-startup-view"
import type * as DocWorkGraph from "@/app/integrations/doc-workgraph"
import * as DocumentMentions from "@/app/integrations/document-mentions"
import * as AIConnectResolution from "@/app/integrations/ai-connect-resolution"
import * as RailGitRemote from "@/app/workbench/rail/rail-git-remote"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { createOnboardingFunnel } from "@/features/onboarding"
import { capture as captureTelemetry, identityProps } from "@/platform/telemetry/analytics"
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
const DialogSettings = lazyDialog(() =>
  import("@/app/dialogs/settings").then((module) => ({ default: module.DialogSettings })),
)
const DialogSelectDirectory = lazyDialog(() =>
  import("@/app/dialogs/select-directory").then((module) => ({ default: module.DialogSelectDirectory })),
)

const turnDocumentIntoWorkLazily: typeof DocWorkGraph.turnDocumentIntoWork = (request) =>
  import("@/app/integrations/doc-workgraph").then((module) => module.turnDocumentIntoWork(request))

export function useOnboardingFunnel() {
  const platform = usePlatform()
  const config = Config.useConfigOptional()
  return createOnboardingFunnel({
    deployment: platform.platform === "desktop" || config?.sandboxEnabled ? "hosted" : "self-host",
    // `step_done` carries its own `surface` and overrides the default below.
    capture: (name, properties) => captureTelemetry(name, { ...identityProps(), surface: "onboarding", ...properties }),
  })
}

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
  NavigationRowStatusGutter: Navigation.NavigationRowStatusGutter,
  NavigationRowGlyph: Navigation.NavigationRowGlyph,
  ensureActionDirectorySessionCache: LayoutActions.ensureDirectorySessionCache,
  findProjectForWorkspace: LayoutActions.findProjectForWorkspace,
  findWorkspaceForDirectory: LayoutActions.findWorkspaceForDirectory,
  message: LayoutActions.message,
  sessionRefForActionWorkspace: LayoutActions.sessionRefForActionWorkspace,
  recoverMissingWorkspace: WorkspaceRecovery.recoverMissingWorkspace,
  loadManageModelsDialog: () => import("@/app/dialogs/manage-models"),
  loadSelectProviderDialog: () => import("@/app/dialogs/select-provider"),
  loadConnectProviderDialog: () => import("@/app/dialogs/connect-provider"),
  loadAIConnectDialog: () => import("@/app/dialogs/connect-ai"),
  applyAIConnectionResults: AIConnectResolution.applyAIConnectionResults,
  filterMcpCatalogEntries: Marketplace.filterMcpCatalogEntries,
  installDisabledReasonForEntry: Marketplace.installDisabledReasonForEntry,
  installMcpDialogEntry: Marketplace.installMcpDialogEntry,
  isEntryInstalled: Marketplace.isEntryInstalled,
  loadMcpDialogData: Marketplace.loadMcpDialogData,
  sourceLabel: Marketplace.sourceLabel,
  targetLabel: Marketplace.targetLabel,
  uninstallMcpDialogEntry: Marketplace.uninstallMcpDialogEntry,
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
  // Lazy boundary: doc-workgraph statically imports @claxedo/workgraph/contracts
  // (zod-based schemas) plus the documents action schemas, which would ride the
  // boot-path feature-ports chunk. The port only needs the FUNCTION when a user
  // actually turns a document into work, and it is already async — so the
  // zod-heavy module graph loads on first invocation instead of at boot.
  // Guarded by scripts/forbidden-eager-deps.config.ts (zod + workgraph/contracts).
  turnDocumentIntoWork: turnDocumentIntoWorkLazily,
})

configureWorkGraphAppPorts({
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
})

configureWorkspacesAppPorts({
  useServer: Server.useServer,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  getAvatarColors: Layout.getAvatarColors,
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useClaxedoEvents: Events.useClaxedoEvents,
  useConfigOptional: Config.useConfigOptional,
  emitTerminalFit: TerminalFit.emitTerminalFit,
  DialogRecoverWorkspace,
  DialogDeleteWorkspace,
  DialogSettings,
  DialogSelectDirectory,
  DialogConnectIntegration,
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
})

if (rendererTraceEnabled()) {
  performance.mark("runtime.featurePortsModuleEvaluated")
}
