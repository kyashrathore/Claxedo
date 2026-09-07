import type { ClaxedoServerClient, ServerScope } from "@/app/connection/server-client"
import { queryClient } from "@/platform/query/query-client"

export const globalSyncServerClientQueryRoot = ["shell", "global-sync-server-client"] as const

function normalized(url: string | undefined) {
  const trimmed = url?.trim()
  if (!trimmed) return "default"
  return trimmed.replace(/\/+$/, "")
}

export function globalSyncServerClientQueryKey(input: {
  owner: string
  serverUrl?: string
  directory: NonNullable<ServerScope["directory"]>
  workspaceId?: string
}) {
  return [
    ...globalSyncServerClientQueryRoot,
    input.owner,
    normalized(input.serverUrl),
    input.directory,
    input.workspaceId ?? "",
  ] as const
}

export function cachedGlobalSyncServerClient<T extends ClaxedoServerClient>(input: {
  owner: string
  serverUrl?: string
  directory: NonNullable<ServerScope["directory"]>
  workspaceId?: string
  create: () => T
}) {
  const queryKey = globalSyncServerClientQueryKey(input)
  const cached = queryClient.getQueryData<T>(queryKey)
  if (cached) return cached
  const next = input.create()
  queryClient.setQueryData(queryKey, next)
  return next
}

export function clearGlobalSyncServerClientsForDirectory(input: { owner: string; directory: NonNullable<ServerScope["directory"]> }) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: globalSyncServerClientQueryRoot })) {
    const key = query.queryKey
    if (key[2] !== input.owner) continue
    if (key[4] !== input.directory && key[5] !== input.directory) continue
    queryClient.removeQueries({ queryKey: key, exact: true })
  }
}

export function clearGlobalSyncServerClientsForOwner(owner: string) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: globalSyncServerClientQueryRoot })) {
    if (query.queryKey[2] === owner) queryClient.removeQueries({ queryKey: query.queryKey, exact: true })
  }
}

export function resetGlobalSyncServerClientCacheForTest() {
  queryClient.removeQueries({ queryKey: globalSyncServerClientQueryRoot })
}
