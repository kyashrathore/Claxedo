import {
  createWorkspaceRuntimeClient,
  type WorkspaceRuntimeClient,
  type WorkspaceRuntimeClientOptions,
} from "@claxedo/workspace-runtime/client"
import type { ServerConnection } from "@/platform/connection/server-connection"
import { createServerRoutesClient, type ServerRoutesClient } from "./server-routes"

export type { WorkspaceRuntimeResponse as ServerClientResponse, WorkspaceScope as ServerScope } from "@claxedo/workspace-runtime/client"

/** Every route the app reaches through one server URL: the runtime's, dispatched behind it, and the server's own. */
export type ClaxedoServerClient = WorkspaceRuntimeClient & ServerRoutesClient

export type CreateServerClientOptions = Omit<WorkspaceRuntimeClientOptions, "baseUrl" | "fetch"> & {
  server: ServerConnection.HttpBase
  request?: WorkspaceRuntimeClientOptions["fetch"]
}

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? ""}:${input.password}`)
}

export function createServerClient({ server, request, ...config }: CreateServerClientOptions): ClaxedoServerClient {
  const auth = (() => {
    if (!server.password) return undefined
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()
  const options: WorkspaceRuntimeClientOptions = {
    ...config,
    fetch: request,
    headers: {
      ...Object.fromEntries(new Headers(config.headers).entries()),
      ...auth,
    },
    baseUrl: server.url,
  }
  return { ...createWorkspaceRuntimeClient(options), ...createServerRoutesClient(options) }
}
