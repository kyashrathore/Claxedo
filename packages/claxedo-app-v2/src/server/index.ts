import type { Accessor } from "solid-js"
import type { QueryClient } from "@tanstack/solid-query"
import type { ConnectionState, ServerEvent } from "./events"
<<<<<<< HEAD
import type { PlacementId, ProjectId, RequestId } from "./ids"
import type { ServerQueries } from "./queries"
=======
import type { PlacementId, ProjectId, RequestId, TerminalId } from "./ids"
>>>>>>> feat/app-v2
import type {
  AgentRequestReply,
  Capabilities,
  DiffFile,
  DiffScope,
  DiffSummary,
  FetchQuery,
  FileContent,
  FileNode,
  GitBases,
  GitCommit,
  GitCommitInput,
  GitPushInput,
  GitPushResult,
  GitRefs,
  GitStatus,
  Placement,
  Project,
  ProjectSource,
  PromptInput,
  SessionCreateInput,
  SessionPage,
  SessionRef,
  SessionRow,
  SessionSnapshot,
  Terminal,
  TerminalAgentStatus,
  TerminalAttachInput,
  TerminalCreateInput,
  TerminalPresence,
  TerminalStream,
  TerminalUpdateInput,
  TranscriptPage,
  WorktreeCreateInput,
} from "./types"

export type * from "./types"
export type * from "./events"
export * from "./ids"
export type { AuthSource, ServerConfig } from "./config"
export type { ServerQueries } from "./queries"
export type { Account, Provider, ProviderList, ProviderModel } from "./accounts"
export type { FileContent, FileNode, FileStatus } from "./files"
export type { GitCommit, GitStatus, GitStatusEntry } from "./git"
export type { MarketplaceCatalog, PluginCandidate, PluginHarness } from "./marketplace"
export type { FeatureAvailability } from "./tasks"
export type { UsageRequest, UsageSummary } from "./usage"
export { ServerError, isRetryable, toAppError } from "./errors"
export { ServerContext, useServer } from "./context"
export { createServer, type ServerHandle } from "./server"
export { ServerProvider } from "./provider"

export type SessionsApi = {
  readonly list: (input: { readonly cursor?: string; readonly limit: number }) => Promise<SessionPage>
  readonly snapshot: (ref: SessionRef) => Promise<SessionSnapshot>
  readonly older: (ref: SessionRef, cursor: string) => Promise<TranscriptPage>
  readonly create: (input: SessionCreateInput) => Promise<SessionRow>
  readonly prompt: (ref: SessionRef, input: PromptInput) => Promise<void>
  readonly stop: (ref: SessionRef) => Promise<void>
  readonly reply: (ref: SessionRef, requestId: RequestId, reply: AgentRequestReply) => Promise<void>
  readonly rename: (ref: SessionRef, title: string) => Promise<void>
  readonly archive: (ref: SessionRef, archived: boolean) => Promise<void>
  readonly remove: (ref: SessionRef) => Promise<void>
}

export type ProjectsApi = {
  readonly create: (input: { readonly name?: string; readonly source: ProjectSource }) => Promise<Project>
  readonly update: (id: ProjectId, input: { readonly name?: string; readonly env?: Record<string, string> }) => Promise<Project>
  readonly remove: (id: ProjectId) => Promise<void>
}

export type PlacementsApi = {
  readonly byId: (id: PlacementId) => Placement | undefined
<<<<<<< HEAD
  readonly list: () => readonly Placement[]
=======
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

export type ServerQueries = {
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
  readonly placements: {
    readonly byProject: (projectId: ProjectId) => FetchQuery<readonly Placement[]>
  }
>>>>>>> feat/app-v2
}

export type Server = {
  readonly connection: Accessor<ConnectionState>
  readonly capabilities: Accessor<Capabilities | undefined>
  readonly queryClient: QueryClient
  readonly subscribe: (handler: (event: ServerEvent) => void) => () => void
  readonly sessions: SessionsApi
  readonly projects: ProjectsApi
  readonly placements: PlacementsApi
<<<<<<< HEAD
  readonly queries: ServerQueries
=======
  readonly terminals: TerminalsApi
  readonly git: GitApi
  readonly queries: ServerQueries
}

export const ServerContext = createContext<Server>()

export function useServer(): Server {
  const server = useContext(ServerContext)
  if (!server) throw new Error("useServer needs a ServerContext provider above it")
  return server
>>>>>>> feat/app-v2
}
