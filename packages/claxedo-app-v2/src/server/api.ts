import type { Accessor } from "solid-js"
import type { QueryClient } from "@tanstack/solid-query"
import type { Account, AccountCheck, AccountKeyInput, EffectiveAccounts, MachineLogin } from "./account-types"
import type { CloudCreateInput, CloudWorkspace, CodeHostConnection, CodeHostRepository } from "./cloud-types"
import type { ConnectionState, ServerEvent } from "./events"
import type { IntegrationQueries, IntegrationsApi } from "./integrations"
import type { SandboxProviderQueries, SandboxProvidersApi } from "./sandbox-providers"
import type { FolderQueries, FoldersApi } from "./folders"
import type { HarnessConfigApi } from "./harness-config"
import type {
  DiffFile,
  DiffScope,
  DiffSummary,
  FileContent,
  FileNode,
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
import type { MarketplaceCatalog, PluginActivationInput, PluginChange, PluginSourceInput, PluginSourceRecord } from "./marketplace-types"
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
  HarnessLogin,
  HarnessOptions,
  Machine,
  Placement,
  Project,
  ProjectSource,
  ProjectUpdate,
  PromptDelivery,
  PromptInput,
  QueuedPrompt,
  QueuedPromptAction,
  QueuedPromptControl,
  SessionCreateInput,
  SessionGoal,
  SessionPage,
  SessionRef,
  SessionRow,
  SessionSnapshot,
  SessionStatusRead,
  Subagent,
  TranscriptPage,
} from "./types"
import type { UsageRequest, UsageSummary } from "./usage-types"

export type SessionsApi = {
  readonly list: (input: { readonly cursor?: string; readonly limit: number }) => Promise<SessionPage>
  readonly snapshot: (ref: SessionRef) => Promise<SessionSnapshot>
  readonly older: (ref: SessionRef, cursor: string) => Promise<TranscriptPage>
  readonly latestTurn: (ref: SessionRef) => Promise<TranscriptPage>
  readonly create: (input: SessionCreateInput) => Promise<SessionRow>
  readonly prompt: (ref: SessionRef, input: PromptInput) => Promise<PromptDelivery>
  readonly stop: (ref: SessionRef) => Promise<void>
  readonly reply: (ref: SessionRef, requestId: RequestId, reply: AgentRequestReply) => Promise<void>
  readonly rename: (ref: SessionRef, title: string) => Promise<void>
  readonly archive: (ref: SessionRef, archived: boolean) => Promise<void>
  readonly remove: (ref: SessionRef) => Promise<void>
  readonly statuses: () => Promise<SessionStatusRead>
  readonly newMessageId: () => string
  readonly queue: (ref: SessionRef) => Promise<readonly QueuedPrompt[]>
  readonly controlQueued: (ref: SessionRef, seq: number, action: QueuedPromptAction) => Promise<QueuedPromptControl>
  readonly controlGoal: (ref: SessionRef, action: GoalAction) => Promise<SessionGoal | undefined>
  readonly subagents: (ref: SessionRef) => Promise<readonly Subagent[]>
}

export type ProjectsApi = {
  readonly create: (input: { readonly name?: string; readonly source: ProjectSource }) => Promise<Project>
  readonly update: (id: ProjectId, input: ProjectUpdate) => Promise<Project>
  readonly remove: (id: ProjectId) => Promise<void>
}

export type PlacementsApi = {
  readonly byId: (id: PlacementId) => Placement | undefined
  readonly list: () => readonly Placement[]
  readonly createWorktree: (projectId: ProjectId, input: WorktreeCreateInput) => Promise<Placement>
}

export type TerminalsApi = {
  readonly list: (placementId: PlacementId) => Promise<readonly Terminal[]>
  readonly create: (input: TerminalCreateInput) => Promise<Terminal>
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
  readonly stop: (id: PlacementId) => Promise<void>
  readonly remove: (id: PlacementId) => Promise<void>
}

export type AccountsApi = {
  readonly select: (ids: readonly string[]) => Promise<void>
  readonly selectMachineLogin: (providerIds: readonly string[]) => Promise<void>
  readonly remove: (ids: readonly string[]) => Promise<void>
  readonly check: (id: string) => Promise<AccountCheck>
  readonly checkMachineLogin: (harness: string) => Promise<readonly MachineLogin[]>
  readonly addKey: (input: AccountKeyInput) => Promise<string>
}

export type MarketplaceApi = {
  readonly setActivation: (input: PluginActivationInput) => Promise<PluginChange>
  readonly update: (pluginInstanceId: string, revision: number) => Promise<PluginChange>
  readonly addSource: (input: PluginSourceInput) => Promise<PluginSourceRecord>
  readonly removeSource: (id: string) => Promise<void>
}

export type LivePluginsApi = {
  readonly remove: (pluginId: string) => Promise<void>
}

export type ServerQueries = {
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
  }
  readonly usage: { readonly summary: (input: UsageRequest) => FetchQuery<UsageSummary> }
  readonly marketplace: {
    readonly catalog: (projectId?: ProjectId) => FetchQuery<MarketplaceCatalog>
    readonly sources: () => FetchQuery<readonly PluginSourceRecord[]>
  }
  readonly tasks: { readonly availability: () => FetchQuery<FeatureAvailability> }
  readonly documents: { readonly availability: () => FetchQuery<FeatureAvailability> }
  readonly codeHost: {
    readonly connections: () => FetchQuery<readonly CodeHostConnection[]>
    readonly repositories: (connectionId: string) => FetchQuery<readonly CodeHostRepository[]>
  }
  readonly cloud: { readonly list: () => FetchQuery<readonly CloudWorkspace[]> }
  readonly folders: FolderQueries
  readonly integrations: IntegrationQueries
  readonly sandboxProviders: SandboxProviderQueries
  readonly harnesses: {
    readonly options: (placementId: PlacementId, harness: string) => FetchQuery<HarnessOptions>
    readonly logins: () => FetchQuery<readonly HarnessLogin[]>
  }
  readonly files: {
    readonly tree: (placementId: PlacementId, path: string) => FetchQuery<readonly FileNode[]>
    readonly content: (placementId: PlacementId, path: string) => FetchQuery<FileContent>
    readonly search: (placementId: PlacementId, query: string) => FetchQuery<readonly string[]>
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
  readonly folders: FoldersApi
  readonly integrations: IntegrationsApi
  readonly sandboxProviders: SandboxProvidersApi
  readonly livePlugins: LivePluginsApi
  readonly harnessConfig: HarnessConfigApi
  readonly queries: ServerQueries
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
}
