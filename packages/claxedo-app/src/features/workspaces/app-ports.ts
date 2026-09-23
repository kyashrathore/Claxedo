import type * as Server from "@/app/connection/server"
import type * as ServerHealth from "@/app/connection/server-health"
import type * as GlobalSDK from "@/app/providers/global-sdk/provider"
import type * as Layout from "@/app/providers/layout"
import type * as Events from "@/app/integrations/claxedo-events"
import type * as Config from "@/app/providers/config"
import type * as TerminalFit from "@/features/terminal/workbench/terminal-fit"
import type * as DialogRecoverWorkspaceModule from "@/features/workspaces/ui/dialogs/recover-workspace-dialog"
import type * as DialogDeleteWorkspaceModule from "@/features/workspaces/ui/dialogs/delete-workspace-dialog"
import type * as DialogSelectDirectoryModule from "@/app/dialogs/select-directory"
import type * as LayoutActions from "@/app/workbench/actions/shared"
import type * as SessionQueries from "@/features/session/data/sync/queries"
import type * as State from "@/app/workbench/state"
import type * as SessionCache from "@/features/session/data/sync/directory-session-cache"
import type * as CloudStartup from "@/features/session/ui/components/cloud-startup-view"
import type * as CodeHost from "@/features/onboarding/code-host-api"

export type WorkspacesAppPorts = {
  useServer: typeof Server.useServer
  checkServerHealth: typeof ServerHealth.checkServerHealthCached
  useGlobalSDK: typeof GlobalSDK.useGlobalSDK
  getAvatarColors: typeof Layout.getAvatarColors
  useClaxedoEventsOptional: typeof Events.useClaxedoEventsOptional
  useClaxedoEvents: typeof Events.useClaxedoEvents
  useConfigOptional: typeof Config.useConfigOptional
  emitTerminalFit: typeof TerminalFit.emitTerminalFit
  DialogRecoverWorkspace: typeof DialogRecoverWorkspaceModule.DialogRecoverWorkspace
  DialogDeleteWorkspace: typeof DialogDeleteWorkspaceModule.DialogDeleteWorkspace
  DialogSelectDirectory: typeof DialogSelectDirectoryModule.DialogSelectDirectory
  ensureDirectorySessionCache: typeof LayoutActions.ensureDirectorySessionCache
  findProjectForWorkspace: typeof LayoutActions.findProjectForWorkspace
  message: typeof LayoutActions.message
  missingLocalWorkspace: typeof LayoutActions.missingLocalWorkspace
  sessionRefForActionWorkspace: typeof LayoutActions.sessionRefForActionWorkspace
  directorySessionCacheQueryOptions: typeof SessionQueries.directorySessionCacheQueryOptions
  realDirectory: typeof State.realDirectory
  useDirectorySessionCacheActions: typeof SessionCache.useDirectorySessionCacheActions
  CloudStartupView: typeof CloudStartup.CloudStartupView
  WorkspaceAccessDeniedView: typeof CloudStartup.WorkspaceAccessDeniedView
  WorkspaceStateShell: typeof CloudStartup.WorkspaceStateShell
  WorkspaceStateNote: typeof CloudStartup.WorkspaceStateNote
  WorkspaceStateButton: typeof CloudStartup.WorkspaceStateButton
  isForbiddenConnectionError: typeof CloudStartup.isForbiddenConnectionError
  readCodeHostStatus: typeof CodeHost.readCodeHostStatus
  connectedCodeHosts: typeof CodeHost.connectedCodeHosts
  connectCodeHost: typeof CodeHost.connectCodeHost
  readCodeHostAttempt: typeof CodeHost.readCodeHostAttempt
  listCodeHostRepositories: typeof CodeHost.listCodeHostRepositories
}

let ports: WorkspacesAppPorts | undefined

export function configureWorkspacesAppPorts(value: WorkspacesAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Workspaces app ports are not configured")
  return ports
}

/**
 * A lazy stand-in for one port: the shell configures the ports after this module
 * is evaluated, so each export must defer the lookup to call time. Reading the
 * port through `select` keeps the argument and return types inferred from the
 * real function, which is why no cast is needed to produce one.
 */
function bind<A extends unknown[], R>(select: (ports: WorkspacesAppPorts) => (...args: A) => R) {
  return (...args: A) => select(required())(...args)
}

export const useServer = bind((ports) => ports.useServer)
export const checkServerHealth = bind((ports) => ports.checkServerHealth)
export const useGlobalSDK = bind((ports) => ports.useGlobalSDK)
export const getAvatarColors = bind((ports) => ports.getAvatarColors)
export const useClaxedoEventsOptional = bind((ports) => ports.useClaxedoEventsOptional)
export const useClaxedoEvents = bind((ports) => ports.useClaxedoEvents)
export const useConfigOptional = bind((ports) => ports.useConfigOptional)
export const emitTerminalFit = bind((ports) => ports.emitTerminalFit)
export const DialogRecoverWorkspace = bind((ports) => ports.DialogRecoverWorkspace)
export const DialogDeleteWorkspace = bind((ports) => ports.DialogDeleteWorkspace)
export const DialogSelectDirectory = bind((ports) => ports.DialogSelectDirectory)
export const ensureDirectorySessionCache = bind((ports) => ports.ensureDirectorySessionCache)
export const findProjectForWorkspace = bind((ports) => ports.findProjectForWorkspace)
export const message = bind((ports) => ports.message)
export const missingLocalWorkspace = bind((ports) => ports.missingLocalWorkspace)
export const sessionRefForActionWorkspace = bind((ports) => ports.sessionRefForActionWorkspace)
export const directorySessionCacheQueryOptions = bind((ports) => ports.directorySessionCacheQueryOptions)
export const realDirectory = bind((ports) => ports.realDirectory)
export const useDirectorySessionCacheActions = bind((ports) => ports.useDirectorySessionCacheActions)
export const CloudStartupView = bind((ports) => ports.CloudStartupView)
export const WorkspaceAccessDeniedView = bind((ports) => ports.WorkspaceAccessDeniedView)
export const WorkspaceStateShell = bind((ports) => ports.WorkspaceStateShell)
export const WorkspaceStateNote = bind((ports) => ports.WorkspaceStateNote)
export const WorkspaceStateButton = bind((ports) => ports.WorkspaceStateButton)
export const isForbiddenConnectionError = bind((ports) => ports.isForbiddenConnectionError)
export const readCodeHostStatus = bind((ports) => ports.readCodeHostStatus)
export const connectedCodeHosts = bind((ports) => ports.connectedCodeHosts)
export const connectCodeHost = bind((ports) => ports.connectCodeHost)
export const readCodeHostAttempt = bind((ports) => ports.readCodeHostAttempt)
export const listCodeHostRepositories = bind((ports) => ports.listCodeHostRepositories)
