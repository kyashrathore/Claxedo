import { createClaxedoServerClient, type CreateClaxedoServerClientOptions } from "@claxedo/agent-runtime-contract/server-client"
import type { ServerConnection } from "@/platform/connection/server-connection"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? ""}:${input.password}`)
}


export function createServerClient({
  server,
  ...config
}: Omit<CreateClaxedoServerClientOptions, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return undefined
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createClaxedoServerClient({
    ...config,
    headers: {
      ...Object.fromEntries(new Headers(config.headers).entries()),
      ...auth,
    },
    baseUrl: server.url,
  })
}
