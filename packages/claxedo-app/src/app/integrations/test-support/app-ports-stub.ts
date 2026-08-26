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

/** Resolve `exportName` from `modulePath` at call time so mock.module wins. */
function lazy(modulePath: string, exportName: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (): any => (require(modulePath) as Record<string, unknown>)[exportName]
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
  useSDK: lazy("@/app/providers/sdk/sdk", "useSDK"),
  useGlobalSDK: lazy("@/app/providers/global-sdk/provider", "useGlobalSDK"),
  useLayout: lazy("@/app/providers/layout", "useLayout"),
  useServer: lazy("@/app/connection/server", "useServer"),
  formatKeybind: lazy("@/app/providers/command", "formatKeybind"),
  useCommand: lazy("@/app/providers/command", "useCommand"),
  useFile: lazy("@/app/providers/file", "useFile"),
  useProviders: lazy("@/app/providers/use-providers", "useProviders"),
  useGlobalSync: lazy("@/app/providers/global-sync/provider", "useGlobalSync"),
  useTerminal: lazy("@/features/terminal/providers/provider", "useTerminal"),
  createProcessClient: lazy("@/features/processes/data/client", "createProcessClient"),
  parseOwnerRepo: lazy("@/app/workbench/rail/rail-git-remote", "parseOwnerRepo"),
  useClaxedoEventsOptional: lazy("@/app/integrations/claxedo-events", "useClaxedoEventsOptional"),
  useFirstTurnFunnel: () => () => ({ emit: () => undefined }),
  useConfigOptional: lazy("@/app/providers/config", "useConfigOptional"),
  useShellQueryOptions: lazy("@/app/integrations/sync/query-options", "useShellQueryOptions"),
  useGlobalBootstrapActions: lazy("@/app/integrations/sync/global-bootstrap", "useGlobalBootstrapActions"),
  useClaxedoState: lazy("@/app/workbench/state", "useClaxedoState"),
  sessionContentPayload: lazy("@/app/workbench/state/session-content-payload", "sessionContentPayload"),
  usePaneId: lazy("@/app/workbench/context/pane-id", "usePaneId"),
  PaneIdProvider: lazy("@/app/workbench/context/pane-id", "PaneIdProvider"),
  workbenchDrag: lazy("@/app/workbench/workbench", "workbenchDrag"),
  useWorkspaceQuery: lazy("@/features/workspaces/data/use-workspace-query", "useWorkspaceQuery"),
  isWorkspaceReady: lazy("@/features/workspaces/data/workspace-connection", "isWorkspaceReady"),
  workspacePlacement: lazy("@/features/workspaces/data/workspace-connection", "workspacePlacement"),
  WorkspaceGate: lazy("@/features/workspaces/data/workspace-gate", "WorkspaceGate"),
  useWorkspaceScopeRegistryOptional: lazy(
    "@/features/workspaces/data/workspace-scope",
    "useWorkspaceScopeRegistryOptional",
  ),
  DirectoryScope: lazy("@/app/workbench/context/directory-scope", "DirectoryScope"),
  StatusPopover: lazy("@/app/connection/status-popover", "StatusPopover"),
  terminalSurfaceStatus: lazy("@/app/workbench/compact-switcher/surface-status", "terminalSurfaceStatus"),
  NavigationRow: lazy("@/app/workbench/navigation/navigation-row", "NavigationRow"),
  NavigationStatusDot: lazy("@/app/workbench/navigation/navigation-row", "NavigationStatusDot"),
  NavigationRowStatusGutter: lazy("@/app/workbench/navigation/navigation-row", "NavigationRowStatusGutter"),
  NavigationRowGlyph: lazy("@/app/workbench/navigation/navigation-row", "NavigationRowGlyph"),
  ensureActionDirectorySessionCache: lazy("@/app/workbench/actions/shared", "ensureDirectorySessionCache"),
  findProjectForWorkspace: lazy("@/app/workbench/actions/shared", "findProjectForWorkspace"),
  findWorkspaceForDirectory: lazy("@/app/workbench/actions/shared", "findWorkspaceForDirectory"),
  message: lazy("@/app/workbench/actions/shared", "message"),
  sessionRefForActionWorkspace: lazy("@/app/workbench/actions/shared", "sessionRefForActionWorkspace"),
  recoverMissingWorkspace: lazy("@/features/workspaces/actions/workspace-recovery", "recoverMissingWorkspace"),
  loadManageModelsDialog: () => () => import("@/app/dialogs/manage-models"),
  loadSelectProviderDialog: () => () => import("@/app/dialogs/select-provider"),
  loadConnectProviderDialog: () => () => import("@/app/dialogs/connect-provider"),
  loadAIConnectDialog: () => () => import("@/app/dialogs/connect-ai"),
  applyAIConnectionResults: lazy("@/app/integrations/ai-connect-resolution", "applyAIConnectionResults"),
  filterMcpCatalogEntries: lazy("@/features/extensions/marketplace/api", "filterMcpCatalogEntries"),
  installDisabledReasonForEntry: lazy("@/features/extensions/marketplace/api", "installDisabledReasonForEntry"),
  installMcpDialogEntry: lazy("@/features/extensions/marketplace/api", "installMcpDialogEntry"),
  isEntryInstalled: lazy("@/features/extensions/marketplace/api", "isEntryInstalled"),
  loadMcpDialogData: lazy("@/features/extensions/marketplace/api", "loadMcpDialogData"),
  sourceLabel: lazy("@/features/extensions/marketplace/api", "sourceLabel"),
  targetLabel: lazy("@/features/extensions/marketplace/api", "targetLabel"),
  uninstallMcpDialogEntry: lazy("@/features/extensions/marketplace/api", "uninstallMcpDialogEntry"),
  listDocumentMentions: lazy("@/app/integrations/document-mentions", "listDocumentMentions"),
  documentMentionText: lazy("@/app/integrations/document-mentions", "documentMentionText"),
}

const terminalThunks: Thunks<TerminalAppPorts> = {
  useSDK: lazy("@/app/providers/sdk/sdk", "useSDK"),
  useClaxedoEventsOptional: lazy("@/app/integrations/claxedo-events", "useClaxedoEventsOptional"),
  useClaxedoState: lazy("@/app/workbench/state", "useClaxedoState"),
  SessionPaneScope: lazy("@/features/session/ui/components/session-pane-scope", "SessionPaneScope"),
  NavigationRow: lazy("@/app/workbench/navigation/navigation-row", "NavigationRow"),
  NavigationStatusDot: lazy("@/app/workbench/navigation/navigation-row", "NavigationStatusDot"),
  NavigationRowStatusGutter: lazy("@/app/workbench/navigation/navigation-row", "NavigationRowStatusGutter"),
  NavigationRowGlyph: lazy("@/app/workbench/navigation/navigation-row", "NavigationRowGlyph"),
  workspacePlacement: lazy("@/features/workspaces/data/workspace-connection", "workspacePlacement"),
  recoverMissingWorkspace: lazy("@/features/workspaces/actions/workspace-recovery", "recoverMissingWorkspace"),
  TerminalNewView: lazy("@/app/workbench/terminal/terminal-new-view", "TerminalNewView"),
}

const settingsThunks: Thunks<SettingsAppPorts> = {
  useProviders: lazy("@/app/providers/use-providers", "useProviders"),
  useGlobalSDK: lazy("@/app/providers/global-sdk/provider", "useGlobalSDK"),
  useShellQueryOptions: lazy("@/app/integrations/sync/query-options", "useShellQueryOptions"),
  DialogConnectProvider: lazy("@/app/dialogs/connect-provider", "DialogConnectProvider"),
  DialogAIConnect: lazy("@/app/dialogs/connect-ai", "DialogAIConnect"),
  DialogSelectProvider: lazy("@/app/dialogs/select-provider", "DialogSelectProvider"),
  DialogCustomProvider: lazy("@/app/dialogs/custom-provider", "DialogCustomProvider"),
  useModels: lazy("@/features/session/providers/models", "useModels"),
  formatKeybind: lazy("@/app/providers/command", "formatKeybind"),
  parseKeybind: lazy("@/app/providers/command", "parseKeybind"),
  useCommand: lazy("@/app/providers/command", "useCommand"),
  DialogConnectIntegration: lazy("@/app/dialogs/connect-integration", "DialogConnectIntegration"),
  Link: lazy("@/app/controls/link", "Link"),
  useSettingsSourceViews: lazy("@/app/integrations/settings-source-views", "useSettingsSourceViews"),
  useSandboxOnboardingFunnel: () => () => ({ emit: () => {} }),
}

const documentsThunks: Thunks<DocumentsAppPorts> = {
  useClaxedoEventsOptional: lazy("@/app/integrations/claxedo-events", "useClaxedoEventsOptional"),
  useSessionSyncOptional: lazy("@/features/session/providers/session-sync", "useSessionSyncOptional"),
  useClaxedoState: lazy("@/app/workbench/state", "useClaxedoState"),
  markdownPathFromHref: lazy("@/app/workbench/lib/open-markdown-page-tab", "markdownPathFromHref"),
  useShellQueryOptions: lazy("@/app/integrations/sync/query-options", "useShellQueryOptions"),
  ensureLocalProject: lazy("@/features/workspaces/data/query/project-ensure", "ensureLocalProject"),
  surfaceRoute: lazy("@/app/workbench/state/surface-route", "surfaceRoute"),
  SessionPaneScope: lazy("@/features/session/ui/components/session-pane-scope", "SessionPaneScope"),
  turnDocumentIntoWork: lazy("@/app/integrations/doc-workgraph", "turnDocumentIntoWork"),
}

const reviewThunks: Thunks<ReviewAppPorts> = {
  useFile: lazy("@/app/providers/file", "useFile"),
  usePrompt: lazy("@/features/session/providers/prompt", "usePrompt"),
  useSDK: lazy("@/app/providers/sdk/sdk", "useSDK"),
  createPanePreferences: lazy("@/features/session/preferences/pane", "createPanePreferences"),
  reviewModePreferenceScope: lazy("@/features/session/preferences/pane", "reviewModePreferenceScope"),
  DialogReleaseNotes: lazy("@/app/dialogs/release-notes", "DialogReleaseNotes"),
}

const workspacesThunks: Thunks<WorkspacesAppPorts> = {
  useServer: lazy("@/app/connection/server", "useServer"),
  useGlobalSDK: lazy("@/app/providers/global-sdk/provider", "useGlobalSDK"),
  getAvatarColors: lazy("@/app/providers/layout", "getAvatarColors"),
  useClaxedoEventsOptional: lazy("@/app/integrations/claxedo-events", "useClaxedoEventsOptional"),
  useClaxedoEvents: lazy("@/app/integrations/claxedo-events", "useClaxedoEvents"),
  useConfigOptional: lazy("@/app/providers/config", "useConfigOptional"),
  emitTerminalFit: lazy("@/features/terminal/workbench/terminal-fit", "emitTerminalFit"),
  DialogRecoverWorkspace: lazy("@/features/workspaces/ui/dialogs/recover-workspace-dialog", "DialogRecoverWorkspace"),
  DialogDeleteWorkspace: lazy("@/features/workspaces/ui/dialogs/delete-workspace-dialog", "DialogDeleteWorkspace"),
  DialogSettings: lazy("@/app/dialogs/settings", "DialogSettings"),
  DialogSelectDirectory: lazy("@/app/dialogs/select-directory", "DialogSelectDirectory"),
  DialogConnectIntegration: lazy("@/app/dialogs/connect-integration", "DialogConnectIntegration"),
  ensureDirectorySessionCache: lazy("@/app/workbench/actions/shared", "ensureDirectorySessionCache"),
  findProjectForWorkspace: lazy("@/app/workbench/actions/shared", "findProjectForWorkspace"),
  message: lazy("@/app/workbench/actions/shared", "message"),
  missingLocalWorkspace: lazy("@/app/workbench/actions/shared", "missingLocalWorkspace"),
  sessionRefForActionWorkspace: lazy("@/app/workbench/actions/shared", "sessionRefForActionWorkspace"),
  directorySessionCacheQueryOptions: lazy("@/features/session/data/sync/queries", "directorySessionCacheQueryOptions"),
  realDirectory: lazy("@/app/workbench/state", "realDirectory"),
  useDirectorySessionCacheActions: lazy(
    "@/features/session/data/sync/directory-session-cache",
    "useDirectorySessionCacheActions",
  ),
  CloudStartupView: lazy("@/features/session/ui/components/cloud-startup-view", "CloudStartupView"),
  WorkspaceAccessDeniedView: lazy("@/features/session/ui/components/cloud-startup-view", "WorkspaceAccessDeniedView"),
  WorkspaceStateShell: lazy("@/features/session/ui/components/cloud-startup-view", "WorkspaceStateShell"),
  WorkspaceStateNote: lazy("@/features/session/ui/components/cloud-startup-view", "WorkspaceStateNote"),
  WorkspaceStateButton: lazy("@/features/session/ui/components/cloud-startup-view", "WorkspaceStateButton"),
  isForbiddenConnectionError: lazy("@/features/session/ui/components/cloud-startup-view", "isForbiddenConnectionError"),
}

const workgraphThunks: Thunks<WorkGraphAppPorts> = {
  useClaxedoEventsOptional: lazy("@/app/integrations/claxedo-events", "useClaxedoEventsOptional"),
}

const onboardingThunks: Thunks<OnboardingAppPorts> = {
  ProviderList: lazy("@/app/dialogs/provider-list", "ProviderList"),
  ProviderConnectForm: lazy("@/app/dialogs/provider-connect-form", "ProviderConnectForm"),
  workspaceSandboxDriversUrl: lazy("@/features/settings/ui/sandbox-section-logic", "workspaceSandboxDriversUrl"),
  workspaceSandboxDriverAuthUrl: lazy("@/features/settings/ui/sandbox-section-logic", "workspaceSandboxDriverAuthUrl"),
  SandboxDriverLogo: lazy("@/features/settings/ui/sandbox-driver-logo", "SandboxDriverLogo"),
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
