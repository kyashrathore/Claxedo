import type { QueryKey, UndefinedInitialDataOptions } from "@tanstack/solid-query"
import { useServer, type AppError, type PlacementId, type ProjectId, type Server, type ServerEvent } from "@/server"
import type { CloudWorkspace, CloudWorkspaceStatus } from "./model"

type Query<T> = ReturnType<UndefinedInitialDataOptions<T, AppError, T, QueryKey>>

export type CloudCreateInput = {
  readonly projectId: ProjectId
  readonly name?: string
  readonly branch?: string
}

export type CloudApi = {
  readonly create: (input: CloudCreateInput) => Promise<CloudWorkspace>
  readonly start: (id: PlacementId) => Promise<void>
  readonly stop: (id: PlacementId) => Promise<void>
  readonly remove: (id: PlacementId) => Promise<void>
}

export type CloudQueries = {
  readonly list: () => Query<readonly CloudWorkspace[]>
}

export type CloudServerEvent =
  | ServerEvent
  | { readonly type: "cloudWorkspaceChanged"; readonly workspaceId: PlacementId; readonly status: CloudWorkspaceStatus }

export type CloudServer = Server & {
  readonly cloud: CloudApi
  readonly queries: { readonly cloud: CloudQueries }
  readonly subscribe: (handler: (event: CloudServerEvent) => void) => () => void
}

export function useCloudServer(): CloudServer {
  return useServer() as CloudServer
}

export function failureReason(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}
