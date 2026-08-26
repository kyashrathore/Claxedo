import type * as Server from "@/app/connection/server"
import type * as GlobalSDK from "@/app/providers/global-sdk/provider"
import type * as Layout from "@/app/providers/layout"
import type * as Events from "@/app/integrations/claxedo-events"
import type * as Config from "@/app/providers/config"
import type * as TerminalFit from "@/features/terminal/workbench/terminal-fit"
import type * as DialogRecoverWorkspaceModule from "@/features/workspaces/ui/dialogs/recover-workspace-dialog"
import type * as DialogDeleteWorkspaceModule from "@/features/workspaces/ui/dialogs/delete-workspace-dialog"
import type * as DialogSettingsModule from "@/app/dialogs/settings"
import type * as DialogSelectDirectoryModule from "@/app/dialogs/select-directory"
import type * as DialogConnectIntegrationModule from "@/app/dialogs/connect-integration"
import type * as LayoutActions from "@/app/workbench/actions/shared"
import type * as SessionQueries from "@/features/session/data/sync/queries"
import type * as State from "@/app/workbench/state"
import type * as SessionCache from "@/features/session/data/sync/directory-session-cache"
import type * as CloudStartup from "@/features/session/ui/components/cloud-startup-view"

export type WorkspacesAppPorts = {
  useServer: typeof Server.useServer
  useGlobalSDK: typeof GlobalSDK.useGlobalSDK
  getAvatarColors: typeof Layout.getAvatarColors
  useClaxedoEventsOptional: typeof Events.useClaxedoEventsOptional
  useClaxedoEvents: typeof Events.useClaxedoEvents
  useConfigOptional: typeof Config.useConfigOptional
  emitTerminalFit: typeof TerminalFit.emitTerminalFit
  DialogRecoverWorkspace: typeof DialogRecoverWorkspaceModule.DialogRecoverWorkspace
  DialogDeleteWorkspace: typeof DialogDeleteWorkspaceModule.DialogDeleteWorkspace
  DialogSettings: typeof DialogSettingsModule.DialogSettings
  DialogSelectDirectory: typeof DialogSelectDirectoryModule.DialogSelectDirectory
  // The create-cloud-project dialog offers "Connect GitHub" when the user has
  // no connected repository yet, and reuses the SAME connect dialog Settings
  // does rather than forking a second connect flow.
  DialogConnectIntegration: typeof DialogConnectIntegrationModule.DialogConnectIntegration
  ensureDirectorySessionCache: typeof LayoutActions.ensureDirectorySessionCache
  findProjectForWorkspace: typeof LayoutActions.findProjectForWorkspace
  message: typeof LayoutActions.message
  missingLocalWorkspace: typeof LayoutActions.missingLocalWorkspace
  sessionRefForActionWorkspace: typeof LayoutActions.sessionRefForActionWorkspace
  workspaceDraftRouteForDirectory: typeof LayoutActions.workspaceDraftRouteForDirectory
  directorySessionCacheQueryOptions: typeof SessionQueries.directorySessionCacheQueryOptions
  realDirectory: typeof State.realDirectory
  useDirectorySessionCacheActions: typeof SessionCache.useDirectorySessionCacheActions
  CloudStartupView: typeof CloudStartup.CloudStartupView
  WorkspaceAccessDeniedView: typeof CloudStartup.WorkspaceAccessDeniedView
  WorkspaceStateShell: typeof CloudStartup.WorkspaceStateShell
  WorkspaceStateNote: typeof CloudStartup.WorkspaceStateNote
  WorkspaceStateButton: typeof CloudStartup.WorkspaceStateButton
  isForbiddenConnectionError: typeof CloudStartup.isForbiddenConnectionError
}

let ports: WorkspacesAppPorts | undefined

export function configureWorkspacesAppPorts(value: WorkspacesAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Workspaces app ports are not configured")
  return ports
}

function bind<K extends keyof WorkspacesAppPorts>(key: K) {
  return ((...args: never[]) => (required()[key] as (...values: never[]) => unknown)(...args)) as WorkspacesAppPorts[K]
}

export const useServer = bind("useServer")
export const useGlobalSDK = bind("useGlobalSDK")
export const getAvatarColors = bind("getAvatarColors")
export const useClaxedoEventsOptional = bind("useClaxedoEventsOptional")
export const useClaxedoEvents = bind("useClaxedoEvents")
export const useConfigOptional = bind("useConfigOptional")
export const emitTerminalFit = bind("emitTerminalFit")
export const DialogRecoverWorkspace = bind("DialogRecoverWorkspace")
export const DialogDeleteWorkspace = bind("DialogDeleteWorkspace")
export const DialogSettings = bind("DialogSettings")
export const DialogSelectDirectory = bind("DialogSelectDirectory")
export const DialogConnectIntegration = bind("DialogConnectIntegration")
export const ensureDirectorySessionCache = bind("ensureDirectorySessionCache")
export const findProjectForWorkspace = bind("findProjectForWorkspace")
export const message = bind("message")
export const missingLocalWorkspace = bind("missingLocalWorkspace")
export const sessionRefForActionWorkspace = bind("sessionRefForActionWorkspace")
export const workspaceDraftRouteForDirectory = bind("workspaceDraftRouteForDirectory")
export const directorySessionCacheQueryOptions = bind("directorySessionCacheQueryOptions")
export const realDirectory = bind("realDirectory")
export const useDirectorySessionCacheActions = bind("useDirectorySessionCacheActions")
export const CloudStartupView = bind("CloudStartupView")
export const WorkspaceAccessDeniedView = bind("WorkspaceAccessDeniedView")
export const WorkspaceStateShell = bind("WorkspaceStateShell")
export const WorkspaceStateNote = bind("WorkspaceStateNote")
export const WorkspaceStateButton = bind("WorkspaceStateButton")
export const isForbiddenConnectionError = bind("isForbiddenConnectionError")
