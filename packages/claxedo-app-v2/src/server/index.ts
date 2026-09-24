import type { Accessor } from "solid-js"
import type { QueryClient } from "@tanstack/solid-query"
import type { ConnectionState, ServerEvent } from "./events"
import type { PlacementId, ProjectId, RequestId } from "./ids"
import type { ServerQueries } from "./queries"
import type {
  AgentRequestReply,
  Capabilities,
  Placement,
  Project,
  ProjectSource,
  PromptInput,
  SessionCreateInput,
  SessionPage,
  SessionRef,
  SessionRow,
  SessionSnapshot,
  TranscriptPage,
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
  readonly list: () => readonly Placement[]
}

export type Server = {
  readonly connection: Accessor<ConnectionState>
  readonly capabilities: Accessor<Capabilities | undefined>
  readonly queryClient: QueryClient
  readonly subscribe: (handler: (event: ServerEvent) => void) => () => void
  readonly sessions: SessionsApi
  readonly projects: ProjectsApi
  readonly placements: PlacementsApi
  readonly queries: ServerQueries
}
