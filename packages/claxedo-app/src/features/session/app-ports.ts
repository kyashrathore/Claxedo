import type * as SDK from "@/app/providers/sdk/sdk"
import type * as GlobalSDK from "@/app/providers/global-sdk/provider"
import type * as Layout from "@/app/providers/layout"
import type * as Server from "@/app/connection/server"
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
  workbenchDrag: typeof Workbench.workbenchDrag
  useWorkspaceQuery: typeof WorkspaceQuery.useWorkspaceQuery
  isWorkspaceReady: typeof WorkspaceConnection.isWorkspaceReady
  workspacePlacement: typeof WorkspaceConnection.workspacePlacement
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
  openSettingsProviders: (dialog: { show: (element: () => JSX.Element) => unknown }) => Promise<void>
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

function bind<K extends keyof SessionAppPorts>(key: K) {
  return ((...args: never[]) => (required()[key] as (...values: never[]) => unknown)(...args)) as SessionAppPorts[K]
}

export const useSDK = bind("useSDK")
export const useGlobalSDK = bind("useGlobalSDK")
export const useLayout = bind("useLayout")
export const useServer = bind("useServer")
export const formatKeybind = bind("formatKeybind")
export const useCommand = bind("useCommand")
export type CommandOption = Command.CommandOption
export const useFile = bind("useFile")
export const useProviders = bind("useProviders")
export const useGlobalSync = bind("useGlobalSync")
export const useTerminal = bind("useTerminal")
export const createProcessClient = bind("createProcessClient")
export const parseOwnerRepo = bind("parseOwnerRepo")
export const useClaxedoEventsOptional = bind("useClaxedoEventsOptional")
export const useFirstTurnFunnel = bind("useFirstTurnFunnel")
export const useConfigOptional = bind("useConfigOptional")
export const useShellQueryOptions = bind("useShellQueryOptions")
export const useGlobalBootstrapActions = bind("useGlobalBootstrapActions")
export const useClaxedoState = bind("useClaxedoState")
export type ContentMeta = StateTypes.ContentMeta
export type TerminalAgentStatus = StateTypes.TerminalAgentStatus
export type TerminalLifecycleState = StateTypes.TerminalLifecycleState
export const sessionContentPayload = bind("sessionContentPayload")
export const usePaneId = bind("usePaneId")
export const PaneIdProvider = bind("PaneIdProvider")
export const workbenchDrag = bind("workbenchDrag")
export type PaneCtx = Workbench.PaneCtx
export const useWorkspaceQuery = bind("useWorkspaceQuery")
export const isWorkspaceReady = bind("isWorkspaceReady")
export const workspacePlacement = bind("workspacePlacement")
export const createCloudWorkspace = bind("createCloudWorkspace")
export const WorkspaceGate = bind("WorkspaceGate")
export const useWorkspaceScopeRegistryOptional = bind("useWorkspaceScopeRegistryOptional")
export const DirectoryScope = bind("DirectoryScope")
export type SwitcherStatus = SwitcherItems.SwitcherStatus
export const terminalSurfaceStatus = bind("terminalSurfaceStatus")
export const NavigationRow = bind("NavigationRow")
export const NavigationStatusDot = bind("NavigationStatusDot")
export const NavigationRowStatusGutter = bind("NavigationRowStatusGutter")
export const NavigationRowGlyph = bind("NavigationRowGlyph")
export type SessionItem = RailTypes.SessionItem
export type ProjectItem = RailTypes.ProjectItem
export type ActionProps = LayoutActions.ActionProps
export type Nav = LayoutActions.Nav
export const ensureActionDirectorySessionCache = bind("ensureActionDirectorySessionCache")
export const findProjectForWorkspace = bind("findProjectForWorkspace")
export const findWorkspaceForDirectory = bind("findWorkspaceForDirectory")
export const message = bind("message")
export const sessionRefForActionWorkspace = bind("sessionRefForActionWorkspace")
export const recoverMissingWorkspace = bind("recoverMissingWorkspace")
export const loadManageModelsDialog = bind("loadManageModelsDialog")
export const openSettingsProviders = bind("openSettingsProviders")
export const listDocumentMentions = bind("listDocumentMentions")
export const documentMentionText = bind("documentMentionText")
export type DocumentMentionOption = DocumentMentions.DocumentMentionOption
