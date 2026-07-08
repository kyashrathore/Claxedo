import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "../../shared/query/query-client"

export const globalSyncSdkClientQueryRoot = ["shell", "global-sync-sdk-client"] as const

function normalized(url: string | undefined) {
  const trimmed = url?.trim()
  if (!trimmed) return "default"
  return trimmed.replace(/\/+$/, "")
}

export function globalSyncSdkClientQueryKey(input: {
  owner: string
  serverUrl?: string
  directory: string
  workspaceId?: string
}) {
  return [
    ...globalSyncSdkClientQueryRoot,
    input.owner,
    normalized(input.serverUrl),
    input.directory,
    input.workspaceId ?? "",
  ] as const
}

export function cachedGlobalSyncSdkClient<T extends OpencodeClient>(input: {
  owner: string
  serverUrl?: string
  directory: string
  workspaceId?: string
  create: () => T
}) {
  const queryKey = globalSyncSdkClientQueryKey(input)
  const cached = queryClient.getQueryData<T>(queryKey)
  if (cached) return cached
  const next = input.create()
  queryClient.setQueryData(queryKey, next)
  return next
}

export function clearGlobalSyncSdkClientsForDirectory(input: { owner: string; directory: string }) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: globalSyncSdkClientQueryRoot })) {
    const key = query.queryKey
    if (key[2] !== input.owner) continue
    if (key[4] !== input.directory && key[5] !== input.directory) continue
    queryClient.removeQueries({ queryKey: key, exact: true })
  }
}

export function clearGlobalSyncSdkClientsForOwner(owner: string) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: globalSyncSdkClientQueryRoot })) {
    if (query.queryKey[2] === owner) queryClient.removeQueries({ queryKey: query.queryKey, exact: true })
  }
}

export function resetGlobalSyncSdkClientCacheForTest() {
  queryClient.removeQueries({ queryKey: globalSyncSdkClientQueryRoot })
}
