/**
 * Test-only wiring for the feature app-ports seam.
 *
 * Production wires ports once at boot (`src/app/integrations/feature-ports.ts`,
 * imported by `src/app/entry/app.tsx`). Unit tests never import the app entry,
 * so feature code that goes through `@/features/<x>/app-ports` throws
 * "... app ports are not configured".
 *
 * `configureAppPortsForTest()` installs ports that resolve each entry lazily,
 * at call time, via `require()` of the same module the production wiring uses.
 * Because Bun's `mock.module` registry is honored by `require()`, a test that
 * mocks e.g. `@/app/providers/sdk/sdk` gets its mock through the port — exactly
 * the behavior tests had before the ports seam existed, when feature code
 * imported those modules directly. Modules a test does not mock resolve to the
 * real implementation, and are only loaded if the port is actually called.
 *
 * Call it in `beforeEach` (or `beforeAll`) — each call replaces the previous
 * configuration wholesale, so per-file overrides cannot leak across suites.
 */
import { configureSessionAppPorts, type SessionAppPorts } from "@/features/session/app-ports"
import { configureTerminalAppPorts, type TerminalAppPorts } from "@/features/terminal/app-ports"
import { configureSettingsAppPorts, type SettingsAppPorts } from "@/features/settings/app-ports"
import { configureDocumentsAppPorts, type DocumentsAppPorts } from "@/features/documents/app-ports"
import { configureReviewAppPorts, type ReviewAppPorts } from "@/features/review/app-ports"
import { configureWorkspacesAppPorts, type WorkspacesAppPorts } from "@/features/workspaces/app-ports"
import { configureWorkGraphAppPorts, type WorkGraphAppPorts } from "@/features/workgraph/app-ports"
import { configureOnboardingAppPorts, type OnboardingAppPorts } from "@/features/onboarding/app-ports"
import * as MAppConnectionServer from "@/app/connection/server"
import * as MAppConnectionStatusPopover from "@/app/connection/status-popover"
import * as MAppControlsLink from "@/app/controls/link"
import * as MAppDialogsConnectAi from "@/app/dialogs/connect-ai"
import * as MAppDialogsConnectIntegration from "@/app/dialogs/connect-integration"
import * as MAppDialogsConnectProvider from "@/app/dialogs/connect-provider"
import * as MAppDialogsCustomProvider from "@/app/dialogs/custom-provider"
import * as MAppDialogsProviderConnectForm from "@/app/dialogs/provider-connect-form"
import * as MAppDialogsProviderList from "@/app/dialogs/provider-list"
import * as MAppDialogsReleaseNotes from "@/app/dialogs/release-notes"
import * as MAppDialogsSelectDirectory from "@/app/dialogs/select-directory"
import * as MAppDialogsSelectProvider from "@/app/dialogs/select-provider"
import * as MAppDialogsSettings from "@/app/dialogs/settings"
import * as MAppIntegrationsClaxedoEvents from "@/app/integrations/claxedo-events"
import * as MAppIntegrationsDocWorkgraph from "@/app/integrations/doc-workgraph"
import * as MAppIntegrationsDocumentMentions from "@/app/integrations/document-mentions"
import * as MAppIntegrationsSettingsSourceViews from "@/app/integrations/settings-source-views"
import * as MAppIntegrationsSyncGlobalBootstrap from "@/app/integrations/sync/global-bootstrap"
import * as MAppIntegrationsSyncQueryOptions from "@/app/integrations/sync/query-options"
import * as MAppProvidersCommand from "@/app/providers/command"
import * as MAppProvidersConfig from "@/app/providers/config"
import * as MAppProvidersFile from "@/app/providers/file"
import * as MAppProvidersGlobalSdkProvider from "@/app/providers/global-sdk/provider"
import * as MAppProvidersGlobalSyncProvider from "@/app/providers/global-sync/provider"
import * as MAppProvidersLayout from "@/app/providers/layout"
import * as MAppProvidersSdkSdk from "@/app/providers/sdk/sdk"
import * as MAppProvidersUseProviders from "@/app/providers/use-providers"
import * as MAppWorkbenchActionsShared from "@/app/workbench/actions/shared"
import * as MAppWorkbenchCompactSwitcherSurfaceStatus from "@/app/workbench/compact-switcher/surface-status"
import * as MAppWorkbenchContextDirectoryScope from "@/app/workbench/context/directory-scope"
import * as MAppWorkbenchContextPaneId from "@/app/workbench/context/pane-id"
import * as MAppWorkbenchLibOpenMarkdownPageTab from "@/app/workbench/lib/open-markdown-page-tab"
import * as MAppWorkbenchNavigationNavigationRow from "@/app/workbench/navigation/navigation-row"
import * as MAppWorkbenchRailRailGitRemote from "@/app/workbench/rail/rail-git-remote"
import * as MAppWorkbenchState from "@/app/workbench/state"
import * as MAppWorkbenchStateSessionContentPayload from "@/app/workbench/state/session-content-payload"
import * as MAppWorkbenchStateSurfaceRoute from "@/app/workbench/state/surface-route"
import * as MAppWorkbenchTerminalTerminalNewView from "@/app/workbench/terminal/terminal-new-view"
import * as MAppWorkbenchWorkbench from "@/app/workbench/workbench"
import * as MFeaturesExtensionsMarketplaceApi from "@/features/extensions/marketplace/api"
import * as MFeaturesProcessesDataClient from "@/features/processes/data/client"
import * as MFeaturesSessionDataSyncQueries from "@/features/session/data/sync/queries"
import * as MFeaturesSessionPreferencesPane from "@/features/session/preferences/pane"
import * as MFeaturesSessionProvidersModels from "@/features/session/providers/models"
import * as MFeaturesSessionProvidersPrompt from "@/features/session/providers/prompt"
import * as MFeaturesSessionProvidersSessionSync from "@/features/session/providers/session-sync"
import * as MFeaturesSessionUiComponentsCloudStartupView from "@/features/session/ui/components/cloud-startup-view"
import * as MFeaturesSessionUiComponentsSessionPaneScope from "@/features/session/ui/components/session-pane-scope"
import * as MFeaturesSettingsUiSandboxDriverLogo from "@/features/settings/ui/sandbox-driver-logo"
import * as MFeaturesSettingsUiSandboxSectionLogic from "@/features/settings/ui/sandbox-section-logic"
import * as MFeaturesTerminalProvidersProvider from "@/features/terminal/providers/provider"
import * as MFeaturesTerminalWorkbenchTerminalFit from "@/features/terminal/workbench/terminal-fit"
import * as MFeaturesWorkspacesActionsWorkspaceRecovery from "@/features/workspaces/actions/workspace-recovery"
import * as MFeaturesWorkspacesDataQueryProjectEnsure from "@/features/workspaces/data/query/project-ensure"
import * as MFeaturesWorkspacesDataUseWorkspaceQuery from "@/features/workspaces/data/use-workspace-query"
import * as MFeaturesWorkspacesDataWorkspaceConnection from "@/features/workspaces/data/workspace-connection"
import * as MFeaturesWorkspacesDataWorkspaceGate from "@/features/workspaces/data/workspace-gate"
import * as MFeaturesWorkspacesUiDialogsDeleteWorkspaceDialog from "@/features/workspaces/ui/dialogs/delete-workspace-dialog"
import * as MFeaturesWorkspacesUiDialogsRecoverWorkspaceDialog from "@/features/workspaces/ui/dialogs/recover-workspace-dialog"
import * as MFeaturesSessionDataSyncDirectorySessionCache from "@/features/session/data/sync/directory-session-cache"
import * as MFeaturesWorkspacesDataWorkspaceScope from "@/features/workspaces/data/workspace-scope"

export type AppPortsTestOverrides = {
  session?: Partial<SessionAppPorts>
  terminal?: Partial<TerminalAppPorts>
  settings?: Partial<SettingsAppPorts>
  documents?: Partial<DocumentsAppPorts>
  review?: Partial<ReviewAppPorts>
  workspaces?: Partial<WorkspacesAppPorts>
  workgraph?: Partial<WorkGraphAppPorts>
  onboarding?: Partial<OnboardingAppPorts>
}

type Thunks<P> = { [K in keyof P]: () => P[K] }

/**
 * Resolve `exportName` from an already-imported module namespace at CALL time,
 * so `mock.module` still wins: Bun's `mock.module` updates the namespace object
 * of a module that has already been imported, and this reads the property on
 * every call rather than capturing it.
 *
 * This used to be `require(modulePath)`. Bun cannot `require()` a module that a
 * plugin loaded and that has already been reached through `import()` — it
 * throws "Requested module is already fetched." — and the Solid 2 test JSX
 * transform is exactly such a plugin, so every `.tsx` port in a test's static
 * import graph failed here. Namespace imports have no such restriction.
 */
function port<M extends object, K extends keyof M>(module: M, exportName: K) {
  return () => module[exportName]
}

function portsFromThunks<P extends object>(thunks: Thunks<P>, overrides: Partial<P>): P {
  const ports = {} as P
  for (const key of Object.keys(thunks) as (keyof P & string)[]) {
    Object.defineProperty(ports, key, {
      enumerable: true,
      get: () => (key in overrides ? overrides[key] : thunks[key]()),
    })
  }
  return ports
}

const sessionThunks: Thunks<SessionAppPorts> = {
  useSDK: port(MAppProvidersSdkSdk, "useSDK"),
  useGlobalSDK: port(MAppProvidersGlobalSdkProvider, "useGlobalSDK"),
  useLayout: port(MAppProvidersLayout, "useLayout"),
  useServer: port(MAppConnectionServer, "useServer"),
  formatKeybind: port(MAppProvidersCommand, "formatKeybind"),
  useCommand: port(MAppProvidersCommand, "useCommand"),
  useFile: port(MAppProvidersFile, "useFile"),
  useProviders: port(MAppProvidersUseProviders, "useProviders"),
  useGlobalSync: port(MAppProvidersGlobalSyncProvider, "useGlobalSync"),
  useTerminal: port(MFeaturesTerminalProvidersProvider, "useTerminal"),
  createProcessClient: port(MFeaturesProcessesDataClient, "createProcessClient"),
  parseOwnerRepo: port(MAppWorkbenchRailRailGitRemote, "parseOwnerRepo"),
  useClaxedoEventsOptional: port(MAppIntegrationsClaxedoEvents, "useClaxedoEventsOptional"),
  useFirstTurnFunnel: () => () => ({ emit: () => undefined }),
  useConfigOptional: port(MAppProvidersConfig, "useConfigOptional"),
  useShellQueryOptions: port(MAppIntegrationsSyncQueryOptions, "useShellQueryOptions"),
  useGlobalBootstrapActions: port(MAppIntegrationsSyncGlobalBootstrap, "useGlobalBootstrapActions"),
  useClaxedoState: port(MAppWorkbenchState, "useClaxedoState"),
  sessionContentPayload: port(MAppWorkbenchStateSessionContentPayload, "sessionContentPayload"),
  usePaneId: port(MAppWorkbenchContextPaneId, "usePaneId"),
  PaneIdProvider: port(MAppWorkbenchContextPaneId, "PaneIdProvider"),
  workbenchDrag: port(MAppWorkbenchWorkbench, "workbenchDrag"),
  useWorkspaceQuery: port(MFeaturesWorkspacesDataUseWorkspaceQuery, "useWorkspaceQuery"),
  isWorkspaceReady: port(MFeaturesWorkspacesDataWorkspaceConnection, "isWorkspaceReady"),
  workspacePlacement: port(MFeaturesWorkspacesDataWorkspaceConnection, "workspacePlacement"),
  WorkspaceGate: port(MFeaturesWorkspacesDataWorkspaceGate, "WorkspaceGate"),
  useWorkspaceScopeRegistryOptional: port(MFeaturesWorkspacesDataWorkspaceScope, "useWorkspaceScopeRegistryOptional"),
  DirectoryScope: port(MAppWorkbenchContextDirectoryScope, "DirectoryScope"),
  StatusPopover: port(MAppConnectionStatusPopover, "StatusPopover"),
  terminalSurfaceStatus: port(MAppWorkbenchCompactSwitcherSurfaceStatus, "terminalSurfaceStatus"),
  NavigationRow: port(MAppWorkbenchNavigationNavigationRow, "NavigationRow"),
  NavigationStatusDot: port(MAppWorkbenchNavigationNavigationRow, "NavigationStatusDot"),
  NavigationRowStatusGutter: port(MAppWorkbenchNavigationNavigationRow, "NavigationRowStatusGutter"),
  NavigationRowGlyph: port(MAppWorkbenchNavigationNavigationRow, "NavigationRowGlyph"),
  ensureActionDirectorySessionCache: port(MAppWorkbenchActionsShared, "ensureDirectorySessionCache"),
  findProjectForWorkspace: port(MAppWorkbenchActionsShared, "findProjectForWorkspace"),
  findWorkspaceForDirectory: port(MAppWorkbenchActionsShared, "findWorkspaceForDirectory"),
  workspaceDraftRouteForDirectory: port(MAppWorkbenchActionsShared, "workspaceDraftRouteForDirectory"),
  message: port(MAppWorkbenchActionsShared, "message"),
  sessionRefForActionWorkspace: port(MAppWorkbenchActionsShared, "sessionRefForActionWorkspace"),
  recoverMissingWorkspace: port(MFeaturesWorkspacesActionsWorkspaceRecovery, "recoverMissingWorkspace"),
  loadManageModelsDialog: () => () => import("@/app/dialogs/manage-models"),
  loadSelectProviderDialog: () => () => import("@/app/dialogs/select-provider"),
  loadConnectProviderDialog: () => () => import("@/app/dialogs/connect-provider"),
  loadAIConnectDialog: () => () => import("@/app/dialogs/connect-ai"),
  filterMcpCatalogEntries: port(MFeaturesExtensionsMarketplaceApi, "filterMcpCatalogEntries"),
  installDisabledReasonForEntry: port(MFeaturesExtensionsMarketplaceApi, "installDisabledReasonForEntry"),
  installMcpDialogEntry: port(MFeaturesExtensionsMarketplaceApi, "installMcpDialogEntry"),
  isEntryInstalled: port(MFeaturesExtensionsMarketplaceApi, "isEntryInstalled"),
  loadMcpDialogData: port(MFeaturesExtensionsMarketplaceApi, "loadMcpDialogData"),
  sourceLabel: port(MFeaturesExtensionsMarketplaceApi, "sourceLabel"),
  targetLabel: port(MFeaturesExtensionsMarketplaceApi, "targetLabel"),
  uninstallMcpDialogEntry: port(MFeaturesExtensionsMarketplaceApi, "uninstallMcpDialogEntry"),
  listDocumentMentions: port(MAppIntegrationsDocumentMentions, "listDocumentMentions"),
  documentMentionText: port(MAppIntegrationsDocumentMentions, "documentMentionText"),
}

const terminalThunks: Thunks<TerminalAppPorts> = {
  useSDK: port(MAppProvidersSdkSdk, "useSDK"),
  useClaxedoEventsOptional: port(MAppIntegrationsClaxedoEvents, "useClaxedoEventsOptional"),
  useClaxedoState: port(MAppWorkbenchState, "useClaxedoState"),
  SessionPaneScope: port(MFeaturesSessionUiComponentsSessionPaneScope, "SessionPaneScope"),
  NavigationRow: port(MAppWorkbenchNavigationNavigationRow, "NavigationRow"),
  NavigationStatusDot: port(MAppWorkbenchNavigationNavigationRow, "NavigationStatusDot"),
  NavigationRowStatusGutter: port(MAppWorkbenchNavigationNavigationRow, "NavigationRowStatusGutter"),
  NavigationRowGlyph: port(MAppWorkbenchNavigationNavigationRow, "NavigationRowGlyph"),
  workspacePlacement: port(MFeaturesWorkspacesDataWorkspaceConnection, "workspacePlacement"),
  recoverMissingWorkspace: port(MFeaturesWorkspacesActionsWorkspaceRecovery, "recoverMissingWorkspace"),
  TerminalNewView: port(MAppWorkbenchTerminalTerminalNewView, "TerminalNewView"),
}

const settingsThunks: Thunks<SettingsAppPorts> = {
  useProviders: port(MAppProvidersUseProviders, "useProviders"),
  useGlobalSDK: port(MAppProvidersGlobalSdkProvider, "useGlobalSDK"),
  useShellQueryOptions: port(MAppIntegrationsSyncQueryOptions, "useShellQueryOptions"),
  DialogConnectProvider: port(MAppDialogsConnectProvider, "DialogConnectProvider"),
  DialogAIConnect: port(MAppDialogsConnectAi, "DialogAIConnect"),
  DialogSelectProvider: port(MAppDialogsSelectProvider, "DialogSelectProvider"),
  DialogCustomProvider: port(MAppDialogsCustomProvider, "DialogCustomProvider"),
  useModels: port(MFeaturesSessionProvidersModels, "useModels"),
  formatKeybind: port(MAppProvidersCommand, "formatKeybind"),
  parseKeybind: port(MAppProvidersCommand, "parseKeybind"),
  useCommand: port(MAppProvidersCommand, "useCommand"),
  DialogConnectIntegration: port(MAppDialogsConnectIntegration, "DialogConnectIntegration"),
  Link: port(MAppControlsLink, "Link"),
  useSettingsSourceViews: port(MAppIntegrationsSettingsSourceViews, "useSettingsSourceViews"),
  useSandboxOnboardingFunnel: () => () => ({ emit: () => {} }),
}

const documentsThunks: Thunks<DocumentsAppPorts> = {
  useClaxedoEventsOptional: port(MAppIntegrationsClaxedoEvents, "useClaxedoEventsOptional"),
  useSessionSyncOptional: port(MFeaturesSessionProvidersSessionSync, "useSessionSyncOptional"),
  useClaxedoState: port(MAppWorkbenchState, "useClaxedoState"),
  markdownPathFromHref: port(MAppWorkbenchLibOpenMarkdownPageTab, "markdownPathFromHref"),
  useShellQueryOptions: port(MAppIntegrationsSyncQueryOptions, "useShellQueryOptions"),
  ensureLocalProject: port(MFeaturesWorkspacesDataQueryProjectEnsure, "ensureLocalProject"),
  surfaceRoute: port(MAppWorkbenchStateSurfaceRoute, "surfaceRoute"),
  SessionPaneScope: port(MFeaturesSessionUiComponentsSessionPaneScope, "SessionPaneScope"),
  turnDocumentIntoWork: port(MAppIntegrationsDocWorkgraph, "turnDocumentIntoWork"),
}

const reviewThunks: Thunks<ReviewAppPorts> = {
  useFile: port(MAppProvidersFile, "useFile"),
  usePrompt: port(MFeaturesSessionProvidersPrompt, "usePrompt"),
  useSDK: port(MAppProvidersSdkSdk, "useSDK"),
  createPanePreferences: port(MFeaturesSessionPreferencesPane, "createPanePreferences"),
  reviewModePreferenceScope: port(MFeaturesSessionPreferencesPane, "reviewModePreferenceScope"),
  DialogReleaseNotes: port(MAppDialogsReleaseNotes, "DialogReleaseNotes"),
}

const workspacesThunks: Thunks<WorkspacesAppPorts> = {
  useServer: port(MAppConnectionServer, "useServer"),
  useGlobalSDK: port(MAppProvidersGlobalSdkProvider, "useGlobalSDK"),
  getAvatarColors: port(MAppProvidersLayout, "getAvatarColors"),
  useClaxedoEventsOptional: port(MAppIntegrationsClaxedoEvents, "useClaxedoEventsOptional"),
  useClaxedoEvents: port(MAppIntegrationsClaxedoEvents, "useClaxedoEvents"),
  useConfigOptional: port(MAppProvidersConfig, "useConfigOptional"),
  emitTerminalFit: port(MFeaturesTerminalWorkbenchTerminalFit, "emitTerminalFit"),
  DialogRecoverWorkspace: port(MFeaturesWorkspacesUiDialogsRecoverWorkspaceDialog, "DialogRecoverWorkspace"),
  DialogDeleteWorkspace: port(MFeaturesWorkspacesUiDialogsDeleteWorkspaceDialog, "DialogDeleteWorkspace"),
  DialogSettings: port(MAppDialogsSettings, "DialogSettings"),
  DialogSelectDirectory: port(MAppDialogsSelectDirectory, "DialogSelectDirectory"),
  DialogConnectIntegration: port(MAppDialogsConnectIntegration, "DialogConnectIntegration"),
  ensureDirectorySessionCache: port(MAppWorkbenchActionsShared, "ensureDirectorySessionCache"),
  findProjectForWorkspace: port(MAppWorkbenchActionsShared, "findProjectForWorkspace"),
  message: port(MAppWorkbenchActionsShared, "message"),
  missingLocalWorkspace: port(MAppWorkbenchActionsShared, "missingLocalWorkspace"),
  sessionRefForActionWorkspace: port(MAppWorkbenchActionsShared, "sessionRefForActionWorkspace"),
  workspaceDraftRouteForDirectory: port(MAppWorkbenchActionsShared, "workspaceDraftRouteForDirectory"),
  directorySessionCacheQueryOptions: port(MFeaturesSessionDataSyncQueries, "directorySessionCacheQueryOptions"),
  realDirectory: port(MAppWorkbenchState, "realDirectory"),
  useDirectorySessionCacheActions: port(
    MFeaturesSessionDataSyncDirectorySessionCache,
    "useDirectorySessionCacheActions",
  ),
  CloudStartupView: port(MFeaturesSessionUiComponentsCloudStartupView, "CloudStartupView"),
  WorkspaceAccessDeniedView: port(MFeaturesSessionUiComponentsCloudStartupView, "WorkspaceAccessDeniedView"),
  WorkspaceStateShell: port(MFeaturesSessionUiComponentsCloudStartupView, "WorkspaceStateShell"),
  WorkspaceStateNote: port(MFeaturesSessionUiComponentsCloudStartupView, "WorkspaceStateNote"),
  WorkspaceStateButton: port(MFeaturesSessionUiComponentsCloudStartupView, "WorkspaceStateButton"),
  isForbiddenConnectionError: port(MFeaturesSessionUiComponentsCloudStartupView, "isForbiddenConnectionError"),
}

const workgraphThunks: Thunks<WorkGraphAppPorts> = {
  useClaxedoEventsOptional: port(MAppIntegrationsClaxedoEvents, "useClaxedoEventsOptional"),
}

const onboardingThunks: Thunks<OnboardingAppPorts> = {
  ProviderList: port(MAppDialogsProviderList, "ProviderList"),
  ProviderConnectForm: port(MAppDialogsProviderConnectForm, "ProviderConnectForm"),
  workspaceSandboxDriversUrl: port(MFeaturesSettingsUiSandboxSectionLogic, "workspaceSandboxDriversUrl"),
  workspaceSandboxDriverAuthUrl: port(MFeaturesSettingsUiSandboxSectionLogic, "workspaceSandboxDriverAuthUrl"),
  SandboxDriverLogo: port(MFeaturesSettingsUiSandboxDriverLogo, "SandboxDriverLogo"),
}

/**
 * Install test app-ports for every feature. Safe to call repeatedly; each call
 * replaces the full configuration (including any previous overrides).
 */
export function configureAppPortsForTest(overrides: AppPortsTestOverrides = {}) {
  configureSessionAppPorts(portsFromThunks(sessionThunks, overrides.session ?? {}))
  configureTerminalAppPorts(portsFromThunks(terminalThunks, overrides.terminal ?? {}))
  configureSettingsAppPorts(portsFromThunks(settingsThunks, overrides.settings ?? {}))
  configureDocumentsAppPorts(portsFromThunks(documentsThunks, overrides.documents ?? {}))
  configureReviewAppPorts(portsFromThunks(reviewThunks, overrides.review ?? {}))
  configureWorkspacesAppPorts(portsFromThunks(workspacesThunks, overrides.workspaces ?? {}))
  configureWorkGraphAppPorts(portsFromThunks(workgraphThunks, overrides.workgraph ?? {}))
  configureOnboardingAppPorts(portsFromThunks(onboardingThunks, overrides.onboarding ?? {}))
}
