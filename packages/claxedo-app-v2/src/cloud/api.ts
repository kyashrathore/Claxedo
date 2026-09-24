import { useServer, type FetchQuery, type PlacementId, type ProjectId, type Server } from "@/server"
import type { CloudWorkspace } from "./model"

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
  readonly list: () => FetchQuery<readonly CloudWorkspace[]>
}

export type CloudServer = Server & {
  readonly cloud: CloudApi
  readonly queries: { readonly cloud: CloudQueries }
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
