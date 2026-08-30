import { decode64 } from "@/lib/base64"
import {
  createClaxedoServerClient,
  type CreateClaxedoServerClientOptions,
} from "@/platform/api/server-client-contract"
import type { ServerConnection } from "@/platform/connection/server-connection"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? ""}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  }
}

export function createServerClient({
  server,
  ...config
}: Omit<CreateClaxedoServerClientOptions, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
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
