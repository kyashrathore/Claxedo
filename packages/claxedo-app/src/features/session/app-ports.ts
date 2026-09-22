import type * as SDK from "@/app/providers/sdk/sdk"
import type * as GlobalSDK from "@/app/providers/global-sdk/provider"
import type * as Layout from "@/app/providers/layout"
import type * as Server from "@/app/connection/server"
import type * as ServerHealth from "@/app/connection/server-health"
import type * as ProjectCreateFormModule from "@/features/workspaces/ui/project-create-form"
import type * as DialogSelectDirectoryModule from "@/app/dialogs/select-directory"
import type * as DialogSelectMcpModule from "@/app/dialogs/select-mcp"
import type * as Command from "@/app/providers/command"
import type * as FileContext from "@/app/providers/file"
import type * as Providers from "@/app/providers/use-providers"
import type * as GlobalSync from "@/app/providers/global-sync/provider"
import type * as Terminal from "@/features/terminal/providers/provider"
import type * as ProcessClient from "@/features/processes/data/client"
import type * as Events from "@/app/integrations/claxedo-events"
import type * as Config from "@/app/providers/config"
import type * as QueryOptions from "@/app/integrations/sync/query-options"
import type * as GlobalBootstrap from "@/app/integrations/sync/global-bootstrap"
import type * as State from "@/app/workbench/state"
import type * as StateTypes from "@/app/workbench/state/types"
import type * as StatePayload from "@/app/workbench/state/session-content-payload"
import type * as PaneID from "@/app/workbench/context/pane-id"
import type * as PaneCtxModule from "@/app/workbench/context/pane-ctx"
import type * as Workbench from "@/app/workbench/workbench"
import type * as WorkspaceQuery from "@/features/workspaces/data/use-workspace-query"
import type * as WorkspaceConnection from "@/features/workspaces/data/workspace-connection"
import type * as WorkspaceCreate from "@/features/workspaces/data/workspace-create-api"
import type * as WorkspaceGateModule from "@/features/workspaces/data/workspace-gate"
import type * as WorkspaceScope from "@/features/workspaces/data/workspace-scope"
import type * as DirectoryScopeModule from "@/app/workbench/context/directory-scope"
import type * as SwitcherItems from "@/app/workbench/compact-switcher/switcher-items"
import type * as SurfaceStatus from "@/app/workbench/compact-switcher/surface-status"
import type * as Navigation from "@/app/workbench/navigation/navigation-row"
import type * as RailTypes from "@/app/workbench/rail/domain-types"
import type * as LayoutActions from "@/app/workbench/actions/shared"
import type * as WorkspaceRecovery from "@/features/workspaces/actions/workspace-recovery"
import type * as ManageModels from "@/app/dialogs/manage-models"
import type * as DocumentMentions from "@/app/integrations/document-mentions"
import type { JSX } from "solid-js"
import type * as RailGitRemote from "@/app/workbench/rail/rail-git-remote"
export { WORKBENCH_DRAG_MIME } from "@/lib/workbench-drag"

export type SessionAppPorts = {
  useSDK: typeof SDK.useSDK
  useGlobalSDK: typeof GlobalSDK.useGlobalSDK
  useLayout: typeof Layout.useLayout
  useServer: typeof Server.useServer
  checkServerHealth: typeof ServerHealth.checkServerHealthCached
  ProjectCreateForm: typeof ProjectCreateFormModule.ProjectCreateForm
  DialogSelectDirectory: typeof DialogSelectDirectoryModule.DialogSelectDirectory
  DialogSelectMcp: typeof DialogSelectMcpModule.DialogSelectMcp
  formatKeybind: typeof Command.formatKeybind
  useCommand: typeof Command.useCommand
  useFile: typeof FileContext.useFile
  useProviders: typeof Providers.useProviders
  useGlobalSync: typeof GlobalSync.useGlobalSync
  useTerminal: typeof Terminal.useTerminal
  createProcessClient: typeof ProcessClient.createProcessClient
  parseOwnerRepo: typeof RailGitRemote.parseOwnerRepo
  useClaxedoEventsOptional: typeof Events.useClaxedoEventsOptional
  useConfigOptional: typeof Config.useConfigOptional
  useShellQueryOptions: typeof QueryOptions.useShellQueryOptions
  useGlobalBootstrapActions: typeof GlobalBootstrap.useGlobalBootstrapActions
  useClaxedoState: typeof State.useClaxedoState
  sessionContentPayload: typeof StatePayload.sessionContentPayload
  usePaneId: typeof PaneID.usePaneId
  PaneIdProvider: typeof PaneID.PaneIdProvider
  usePaneCtx: typeof PaneCtxModule.usePaneCtx
  useWorkspaceQuery: typeof WorkspaceQuery.useWorkspaceQuery
  isWorkspaceReady: typeof WorkspaceConnection.isWorkspaceReady
  workspacePlacement: typeof WorkspaceConnection.workspaceRelayPlacement
  createCloudWorkspace: typeof WorkspaceCreate.createCloudWorkspace
  WorkspaceGate: typeof WorkspaceGateModule.WorkspaceGate
  useWorkspaceScopeRegistryOptional: typeof WorkspaceScope.useWorkspaceScopeRegistryOptional
  DirectoryScope: typeof DirectoryScopeModule.DirectoryScope
  terminalSurfaceStatus: typeof SurfaceStatus.terminalSurfaceStatus
  NavigationRow: typeof Navigation.NavigationRow
  NavigationStatusDot: typeof Navigation.NavigationStatusDot
  NavigationRowStatusGutter: typeof Navigation.NavigationRowStatusGutter
  NavigationRowGlyph: typeof Navigation.NavigationRowGlyph
  ensureActionDirectorySessionCache: typeof LayoutActions.ensureDirectorySessionCache
  findProjectForWorkspace: typeof LayoutActions.findProjectForWorkspace
  findWorkspaceForDirectory: typeof LayoutActions.findWorkspaceForDirectory
  message: typeof LayoutActions.message
  sessionRefForActionWorkspace: typeof LayoutActions.sessionRefForActionWorkspace
  recoverMissingWorkspace: typeof WorkspaceRecovery.recoverMissingWorkspace
  loadManageModelsDialog: () => Promise<typeof ManageModels>
  listDocumentMentions: typeof DocumentMentions.listDocumentMentions
  documentMentionText: typeof DocumentMentions.documentMentionText
  useFirstTurnFunnel: () => {
    emit(
      event:
        | { name: "first_turn_ok" }
        | { name: "first_turn_failed"; class: "credential" | "harness" | "model" | "usage_limit" | "workspace" | "session" | "unknown" }
        | { name: "first_cloud_turn_ok" },
    ): void
  }
}

let ports: SessionAppPorts | undefined

export function configureSessionAppPorts(value: SessionAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Session app ports are not configured")
  return ports
}

/**
 * A lazy stand-in for one port: the shell configures the ports after this module
 * is evaluated, so each export must defer the lookup to call time. Reading the
 * port through `select` keeps the argument and return types inferred from the
 * real function, which is why no cast is needed to produce one.
 */
function bind<A extends unknown[], R>(select: (ports: SessionAppPorts) => (...args: A) => R) {
  return (...args: A) => select(required())(...args)
}

export const useSDK = bind((ports) => ports.useSDK)
export const useGlobalSDK = bind((ports) => ports.useGlobalSDK)
export const useLayout = bind((ports) => ports.useLayout)
export const useServer = bind((ports) => ports.useServer)
export const checkServerHealth = bind((ports) => ports.checkServerHealth)
export const ProjectCreateForm = bind((ports) => ports.ProjectCreateForm)
export const DialogSelectDirectory = bind((ports) => ports.DialogSelectDirectory)
export const DialogSelectMcp = bind((ports) => ports.DialogSelectMcp)
export const formatKeybind = bind((ports) => ports.formatKeybind)
export const useCommand = bind((ports) => ports.useCommand)
export type CommandOption = Command.CommandOption
export type CommandOwner = Command.CommandOwner
export const useFile = bind((ports) => ports.useFile)
export const useProviders = bind((ports) => ports.useProviders)
export const useGlobalSync = bind((ports) => ports.useGlobalSync)
export const useTerminal = bind((ports) => ports.useTerminal)
export const createProcessClient = bind((ports) => ports.createProcessClient)
export const parseOwnerRepo = bind((ports) => ports.parseOwnerRepo)
export const useClaxedoEventsOptional = bind((ports) => ports.useClaxedoEventsOptional)
export const useFirstTurnFunnel = bind((ports) => ports.useFirstTurnFunnel)
export const useConfigOptional = bind((ports) => ports.useConfigOptional)
export const useShellQueryOptions = bind((ports) => ports.useShellQueryOptions)
export const useGlobalBootstrapActions = bind((ports) => ports.useGlobalBootstrapActions)
export const useClaxedoState = bind((ports) => ports.useClaxedoState)
export type ContentMeta = StateTypes.ContentMeta
export type TerminalAgentStatus = StateTypes.TerminalAgentStatus
export type TerminalLifecycleState = StateTypes.TerminalLifecycleState
export const sessionContentPayload = bind((ports) => ports.sessionContentPayload)
export const usePaneId = bind((ports) => ports.usePaneId)
export const PaneIdProvider = bind((ports) => ports.PaneIdProvider)
export const usePaneCtx = bind((ports) => ports.usePaneCtx)
export type PaneCtx = Workbench.PaneCtx
export const useWorkspaceQuery = bind((ports) => ports.useWorkspaceQuery)
export const isWorkspaceReady = bind((ports) => ports.isWorkspaceReady)
export const workspacePlacement = bind((ports) => ports.workspacePlacement)
export const createCloudWorkspace = bind((ports) => ports.createCloudWorkspace)
export const WorkspaceGate = bind((ports) => ports.WorkspaceGate)
export const useWorkspaceScopeRegistryOptional = bind((ports) => ports.useWorkspaceScopeRegistryOptional)
export const DirectoryScope = bind((ports) => ports.DirectoryScope)
export type PanePresentation = Workbench.PanePresentation
export type SwitcherStatus = SwitcherItems.SwitcherStatus
export const terminalSurfaceStatus = bind((ports) => ports.terminalSurfaceStatus)
export const NavigationRow = bind((ports) => ports.NavigationRow)
export const NavigationStatusDot = bind((ports) => ports.NavigationStatusDot)
export const NavigationRowStatusGutter = bind((ports) => ports.NavigationRowStatusGutter)
export const NavigationRowGlyph = bind((ports) => ports.NavigationRowGlyph)
export type SessionItem = RailTypes.SessionItem
export type ProjectItem = RailTypes.ProjectItem
export type ActionProps = LayoutActions.ActionProps
export type Nav = LayoutActions.Nav
export const ensureActionDirectorySessionCache = bind((ports) => ports.ensureActionDirectorySessionCache)
export const findProjectForWorkspace = bind((ports) => ports.findProjectForWorkspace)
export const findWorkspaceForDirectory = bind((ports) => ports.findWorkspaceForDirectory)
export const message = bind((ports) => ports.message)
export const sessionRefForActionWorkspace = bind((ports) => ports.sessionRefForActionWorkspace)
export const recoverMissingWorkspace = bind((ports) => ports.recoverMissingWorkspace)
export const loadManageModelsDialog = bind((ports) => ports.loadManageModelsDialog)
export const listDocumentMentions = bind((ports) => ports.listDocumentMentions)
export const documentMentionText = bind((ports) => ports.documentMentionText)
export type DocumentMentionOption = DocumentMentions.DocumentMentionOption
