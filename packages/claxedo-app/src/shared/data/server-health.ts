import { usePlatform } from "@/context/platform"
import type { ServerConnection } from "@/context/server"
import { queryClient } from "@/shared/query/query-client"

export type ServerHealth = { healthy: boolean; version?: string }

const cacheMs = 750

type ServerHealthCacheEntry = {
  at: number
  done: boolean
  promise: Promise<ServerHealth>
}

function timeoutSignal(ms: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

export async function checkServerHealth(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch) {
  const timeout = timeoutSignal(3_000)
  try {
    const res = await fetch(claxedoHealthUrl(server.url), {
      signal: timeout.signal,
      headers: server.password ? { authorization: `Bearer ${server.password}` } : undefined,
    })
    if (!res.ok) return { healthy: false }
    const body = await res.json().catch(() => undefined) as { ok?: boolean; healthy?: boolean; version?: string } | undefined
    return {
      healthy: body?.ok === true || body?.healthy === true,
      ...(body?.version ? { version: body.version } : {}),
    }
  } catch {
    return { healthy: false }
  } finally {
    timeout.clear()
  }
}

function claxedoHealthUrl(serverUrl: string) {
  return new URL("/api/claxedo/health", serverUrl)
}

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase) => checkServerHealthCached(http, fetcher)
}

export function checkServerHealthCached(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  now = Date.now,
) {
  const key = serverHealthCacheKey(server)
  const hit = queryClient.getQueryData<ServerHealthCacheEntry>(key)
  const at = now()
  if (hit && (!hit.done || at - hit.at < cacheMs)) return hit.promise

  const promise = checkServerHealth(server, fetch).finally(() => {
    const next = queryClient.getQueryData<ServerHealthCacheEntry>(key)
    if (!next || next.promise !== promise) return
    queryClient.setQueryData<ServerHealthCacheEntry>(key, {
      ...next,
      at: now(),
      done: true,
    })
  })
  queryClient.setQueryData<ServerHealthCacheEntry>(key, { at, done: false, promise })
  return promise
}

export function serverHealthQueryOptions(input: {
  server: ServerConnection.HttpBase
  fetch: typeof globalThis.fetch
  enabled?: boolean
  refetchInterval?: number | false
}) {
  return {
    queryKey: serverHealthQueryKey(input.server),
    queryFn: () => checkServerHealthCached(input.server, input.fetch),
    staleTime: cacheMs,
    enabled: input.enabled ?? true,
    refetchInterval: input.refetchInterval,
    refetchIntervalInBackground: true,
  }
}

export function serverHealthQueryKey(server: ServerConnection.HttpBase) {
  return ["server", "health", server.url, server.username ?? "", server.password ? "password" : "none"] as const
}

function serverHealthCacheKey(server: ServerConnection.HttpBase) {
  return ["server", "health-cache", server.url, server.username ?? "", server.password ? "password" : "none"] as const
}
