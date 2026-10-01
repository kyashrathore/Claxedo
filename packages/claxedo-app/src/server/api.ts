import type { AccountScope, AccountSource } from "@claxedo/account-contract/vocabulary"
import type { Accessor } from "solid-js"
import type { QueryClient } from "@tanstack/solid-query"
import type { RuntimeCommand } from "@claxedo/agent-runtime-contract"
import type { Account, AccountCheck, AccountSources, EffectiveAccounts, HostedAccountSources, MachineLogin } from "./account-types"
import type { CloudCreateInput, CloudWorkspace, CodeHostRepository, WorkspaceRuntime } from "./cloud-types"
import type { HarnessOptions } from "./harness-types"
import type { ConnectionState, ServerEvent } from "./events"
import type { AgentConnectionsApi, AgentConnectionsQueries } from "./agent-connections"
import type { IntegrationQueries, IntegrationsApi } from "./integrations"
import type { ProviderConnectApi, ProviderConnectQueries } from "./provider-connect"
import type { ProviderCatalogQueries, ProviderCatalogsApi } from "./provider-catalogs"
import type { FolderQueries, FoldersApi } from "./folders"
import type { HarnessConfigApi } from "./harness-config"
import type {
  DiffFile,
  DiffScope,
  DiffSummary,
  FileContent,
  FileNode,
  FileSearchEntries,
  GitBases,
  GitCommit,
  GitCommitInput,
  GitPushInput,
  GitPushResult,
  GitRefs,
  GitStatus,
  WorktreeCreateInput,
} from "./git-types"
import type { PlacementId, ProjectId, RequestId, TerminalId } from "./ids"
import type { TasksClient } from "@claxedo/tasks/client"
import type {
  MachineInstalled,
  MarketplaceCatalog,
  PluginActivationInput,
  PluginChange,
  PluginOrganizationDefaultInput,
  PluginSkillDocument,
  PluginSkillRequest,
  PluginSourceInput,
  PluginSourceRecord,
} from "./marketplace-types"
import type {
  Terminal,
  TerminalAgentStatus,
  TerminalAttachInput,
  TerminalCreateInput,
  TerminalPresence,
  TerminalStream,
  TerminalUpdateInput,
} from "./terminal-types"
import type {
  AgentRequestReply,
  Capabilities,
  FeatureAvailability,
  FetchQuery,
  GoalAction,
  HeldSessionReads,
  Machine,
  Placement,
  Project,
  ProjectSource,
  ProjectUpdate,
  PromptDelivery,
  PageShape,
  PromptInput,
  QueuedPrompt,
  ReaderSettings,
  QueuedPromptAction,
  QueuedPromptControl,
  SessionCreateInput,
  SessionGoal,
  SessionListInput,
  SessionPage,
  SessionReads,
  SessionLocation,
  SessionRow,
  Subagent,
  TranscriptPage,
  TranscriptPart,
} from "./types"
import type { UsageRequest, UsageSummary } from "./usage-types"
import type { LivePlugin } from "./live-plugin-types"

export type SessionsApi = {
  readonly list: (input: SessionListInput) => Promise<SessionPage>
  readonly read: (ref: SessionLocation, shape: PageShape, held?: HeldSessionReads) => SessionReads
  readonly page: (ref: SessionLocation, shape: PageShape, before: string) => Promise<TranscriptPage>
  readonly part: (ref: SessionLocation, messageId: string, partId: string) => Promise<TranscriptPart>
  readonly turn: (ref: SessionLocation, turnId: string) => Promise<TranscriptPage>
  readonly create: (input: SessionCreateInput) => Promise<SessionRow>
  readonly prompt: (ref: SessionLocation, input: PromptInput) => Promise<PromptDelivery>
  readonly stop: (ref: SessionLocation) => Promise<void>
  readonly reply: (ref: SessionLocation, requestId: RequestId, reply: AgentRequestReply) => Promise<void>
  readonly rename: (ref: SessionLocation, title: string) => Promise<void>
  readonly archive: (ref: SessionLocation, archived: boolean) => Promise<void>
  readonly remove: (ref: SessionLocation) => Promise<void>
  readonly newMessageId: () => string
  readonly queue: (ref: SessionLocation) => Promise<readonly QueuedPrompt[]>
  readonly controlQueued: (ref: SessionLocation, seq: number, action: QueuedPromptAction) => Promise<QueuedPromptControl>
  readonly replaceQueued: (ref: SessionLocation, seq: number, input: PromptInput, messageId: string) => Promise<boolean>
  readonly controlGoal: (ref: SessionLocation, action: GoalAction) => Promise<SessionGoal | undefined>
}

export type ProjectsApi = {
  readonly create: (input: { readonly name?: string; readonly source: ProjectSource }) => Promise<Project>
  readonly update: (id: ProjectId, input: ProjectUpdate) => Promise<Project>
  readonly remove: (id: ProjectId) => Promise<void>
  readonly reclone: (id: ProjectId) => Promise<Project>
}

export type PlacementsApi = {
  readonly byId: (id: PlacementId) => Placement | undefined
  readonly list: () => readonly Placement[]
  readonly load: () => Promise<readonly Placement[]>
  readonly createWorktree: (projectId: ProjectId, input: WorktreeCreateInput) => Promise<Placement>
}

export type TerminalsApi = {
  readonly list: (placementId: PlacementId) => Promise<readonly Terminal[]>
  readonly create: (input: TerminalCreateInput) => Promise<Terminal>
  readonly requiresOpenSession: (placementId: PlacementId) => boolean
  readonly update: (placementId: PlacementId, terminalId: TerminalId, input: TerminalUpdateInput) => Promise<void>
  readonly remove: (placementId: PlacementId, terminalId: TerminalId) => Promise<void>
  readonly presence: (placementId: PlacementId, terminalId: TerminalId) => Promise<TerminalPresence>
  readonly agents: (placementId: PlacementId) => Promise<readonly string[]>
  readonly agentStatus: (placementId: PlacementId, terminalId: TerminalId) => Promise<TerminalAgentStatus | undefined>
  readonly attach: (input: TerminalAttachInput) => Promise<TerminalStream>
}

export type GitApi = {
  readonly stage: (placementId: PlacementId, paths: readonly string[]) => Promise<void>
  readonly unstage: (placementId: PlacementId, paths: readonly string[]) => Promise<void>
  readonly commit: (placementId: PlacementId, input: GitCommitInput) => Promise<{ readonly hash: string }>
  readonly push: (placementId: PlacementId, input: GitPushInput) => Promise<GitPushResult>
}

export type CloudApi = {
  readonly create: (input: CloudCreateInput) => Promise<CloudWorkspace>
  readonly start: (id: PlacementId) => Promise<void>
  readonly runtime: (id: PlacementId) => WorkspaceRuntime
  readonly stop: (id: PlacementId) => Promise<void>
  readonly remove: (id: PlacementId) => Promise<void>
}

export type AccountsApi = {
  readonly select: (ids: readonly string[]) => Promise<void>
  readonly selectMachineLogin: (providerIds: readonly string[]) => Promise<void>
  readonly setSource: (providerIds: readonly string[], source: AccountSource) => Promise<void>
  readonly setHostedSource: (harness: string, providerId: string, source: AccountSource) => Promise<void>
  readonly setScope: (ids: readonly string[], scope: AccountScope) => Promise<void>
  readonly remove: (ids: readonly string[]) => Promise<void>
  readonly check: (id: string) => Promise<AccountCheck>
  readonly checkMachineLogin: (harness: string) => Promise<readonly MachineLogin[]>
  readonly rescan: () => Promise<void>
}

export type MarketplaceApi = {
  readonly refresh: (projectId?: ProjectId) => Promise<MarketplaceCatalog>
  readonly setActivation: (input: PluginActivationInput) => Promise<PluginChange>
  readonly setOrganizationDefault: (input: PluginOrganizationDefaultInput) => Promise<PluginChange>
  readonly update: (pluginInstanceId: string, revision: number, authority?: "user") => Promise<PluginChange>
  readonly addSource: (input: PluginSourceInput) => Promise<PluginSourceRecord>
  readonly removeSource: (id: string) => Promise<void>
}

export type TaskListKey = {
  readonly projectId: string
  readonly status: string | null
  readonly parent: "any" | "root"
  readonly includeArchived: boolean
}

export type TasksApi = {
  readonly client: TasksClient
  readonly keys: {
    readonly scope: readonly unknown[]
    readonly capabilities: readonly unknown[]
    readonly presets: (includeArchived: boolean) => readonly unknown[]
    readonly list: (filter: TaskListKey) => readonly unknown[]
    readonly detail: (taskId: string) => readonly unknown[]
    readonly children: (taskId: string) => readonly unknown[]
  }
}

export type LivePluginsApi = {
  readonly bundle: (pluginId: string, hash: string) => Promise<string>
  readonly remove: (pluginId: string) => Promise<void>
}

export type ServerQueries = {
  readonly livePlugins: {
    readonly list: () => FetchQuery<readonly LivePlugin[]>
  }
  readonly projects: {
    readonly list: () => FetchQuery<readonly Project[]>
    readonly byId: (id: ProjectId) => FetchQuery<Project>
  }
  readonly placements: {
    readonly list: () => FetchQuery<readonly Placement[]>
    readonly byProject: (projectId: ProjectId) => FetchQuery<readonly Placement[]>
  }
  readonly machines: { readonly list: () => FetchQuery<readonly Machine[]> }
  readonly accounts: {
    readonly list: () => FetchQuery<readonly Account[]>
    readonly effective: () => FetchQuery<EffectiveAccounts>
    readonly machineLogins: () => FetchQuery<readonly MachineLogin[]>
    readonly sources: () => FetchQuery<AccountSources>
    readonly hostedSources: (harness: string) => FetchQuery<HostedAccountSources>
  }
  readonly usage: { readonly summary: (input: UsageRequest) => FetchQuery<UsageSummary> }
  readonly marketplace: {
    readonly catalog: (projectId?: ProjectId) => FetchQuery<MarketplaceCatalog>
    readonly sources: () => FetchQuery<readonly PluginSourceRecord[]>
    readonly skill: (request: PluginSkillRequest) => FetchQuery<PluginSkillDocument>
    readonly machineInstalled: () => FetchQuery<MachineInstalled>
  }
  readonly tasks: { readonly availability: () => FetchQuery<FeatureAvailability> }
  readonly codeHost: {
    readonly repositories: (connectionId: string) => FetchQuery<readonly CodeHostRepository[]>
  }
  readonly cloud: { readonly list: () => FetchQuery<readonly CloudWorkspace[]> }
  readonly folders: FolderQueries
  readonly integrations: IntegrationQueries
  readonly agentConnections: AgentConnectionsQueries
  readonly providerConnect: ProviderConnectQueries
  readonly providerCatalogs: ProviderCatalogQueries
  readonly harnesses: {
    readonly options: (placementId: PlacementId, harness: string) => FetchQuery<HarnessOptions>
    readonly commands: (placementId: PlacementId, harness: string) => FetchQuery<readonly RuntimeCommand[]>
  }
  readonly files: {
    readonly tree: (placementId: PlacementId, path: string) => FetchQuery<readonly FileNode[]>
    readonly content: (placementId: PlacementId, path: string) => FetchQuery<FileContent>
    readonly search: (placementId: PlacementId, query: string, entries: FileSearchEntries) => FetchQuery<readonly string[]>
  }
  readonly git: {
    readonly status: (placementId: PlacementId) => FetchQuery<GitStatus>
    readonly log: (placementId: PlacementId, limit: number) => FetchQuery<readonly GitCommit[]>
    readonly refs: (placementId: PlacementId) => FetchQuery<GitRefs>
    readonly bases: (placementId: PlacementId) => FetchQuery<GitBases>
    readonly diff: (placementId: PlacementId, scope: DiffScope) => FetchQuery<readonly DiffSummary[]>
    readonly diffFile: (placementId: PlacementId, scope: DiffScope, file: string) => FetchQuery<DiffFile>
  }
}

export type Server = {
  readonly connection: Accessor<ConnectionState>
  readonly capabilities: Accessor<Capabilities | undefined>
  readonly queryClient: QueryClient
  readonly subscribe: (handler: (event: ServerEvent) => void) => () => void
  readonly sessions: SessionsApi
  readonly projects: ProjectsApi
  readonly placements: PlacementsApi
  readonly terminals: TerminalsApi
  readonly git: GitApi
  readonly cloud: CloudApi
  readonly accounts: AccountsApi
  readonly marketplace: MarketplaceApi
  readonly tasks: TasksApi
  readonly folders: FoldersApi
  readonly integrations: IntegrationsApi
  readonly agentConnections: AgentConnectionsApi
  readonly providerConnect: ProviderConnectApi
  readonly providerCatalogs: ProviderCatalogsApi
  readonly livePlugins: LivePluginsApi
  readonly harnessConfig: HarnessConfigApi
  readonly queries: ServerQueries
  readonly attachPlacement: (ref: SessionLocation) => () => void
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly operation: (name: string, input: unknown) => Promise<unknown>
  readonly acceptOrgInvitation: (token: string) => Promise<unknown>
}
