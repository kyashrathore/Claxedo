import type { FileContent, FileNode } from "@opencode-ai/sdk/v2"
import { scopeUrl } from "@/lib/url"
import { queryClient, removeExactQuery } from "@/platform/query/query-client"
import { createRefCountedResourceCache } from "@/platform/sync/live-resource-cache"

type FileRuntimeDirectory = string

export type FileRequestRuntime = {
  baseUrl: string
  workspaceId?: string
  directory: FileRuntimeDirectory
}

export function fileRequestRuntimeQueryKey(runtime: FileRequestRuntime) {
  return [
    "shell",
    "file-request",
    scopeUrl(runtime.baseUrl),
    runtime.workspaceId ?? "",
    runtime.directory,
  ] as const
}

export function fileRequestRuntimeKey(runtime: FileRequestRuntime) {
  const key = fileRequestRuntimeQueryKey(runtime)
  return `${key[2]}\0${key[3]}\0${key[4]}`
}

export function fileReadRequestQueryKey(runtime: FileRequestRuntime, file: string) {
  return [...fileRequestRuntimeQueryKey(runtime), "read", file] as const
}

export function fileTreeRequestQueryKey(runtime: FileRequestRuntime, dir: string) {
  return [...fileRequestRuntimeQueryKey(runtime), "tree", dir] as const
}

export function cachedFileReadRequest(input: {
  runtime: FileRequestRuntime
  file: string
  force?: boolean
  read: () => Promise<FileContent | undefined>
}) {
  const queryKey = fileReadRequestQueryKey(input.runtime, input.file)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.read,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * The bytes this file's read request already holds, or `undefined`.
 *
 * `cachedFileReadRequest` never lets a stored result go stale
 * (`staleTime: Infinity`), so a stored result is exactly what awaiting it
 * would resolve with. A caller that can use the bytes synchronously — a file
 * tab mounting a viewer inside the activation that opened it — reads them
 * here instead, and pays no microtask hop for bytes it already has.
 */
export function peekCachedFileReadRequest(runtime: FileRequestRuntime, file: string) {
  return queryClient.getQueryData<FileContent | undefined>(fileReadRequestQueryKey(runtime, file))
}

export function invalidateCachedFileReadRequest(runtime: FileRequestRuntime, file: string) {
  removeExactQuery(fileReadRequestQueryKey(runtime, file))
}

export function cachedFileTreeRequest(input: {
  runtime: FileRequestRuntime
  dir: string
  force?: boolean
  list: () => Promise<FileNode[]>
}) {
  const queryKey = fileTreeRequestQueryKey(input.runtime, input.dir)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.list,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function clearFileRequestCache(runtime?: FileRequestRuntime) {
  queryClient.removeQueries({ queryKey: runtime ? fileRequestRuntimeQueryKey(runtime) : ["shell", "file-request"] })
}

// FileProvider is pane-owned, while its request cache belongs to the concrete
// runtime. Mounting another pane for that runtime must preserve already-warmed
// file/tree requests. The final release is the single lifetime boundary that
// clears those results before an unobserved runtime can go stale.
const fileRequestRuntimeCache = createRefCountedResourceCache<undefined>(32)

export function acquireFileRequestCache(runtime: FileRequestRuntime) {
  const handle = fileRequestRuntimeCache.acquire(fileRequestRuntimeKey(runtime), () => ({
    value: undefined,
    dispose: () => clearFileRequestCache(runtime),
  }))
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      handle.release()
    },
  }
}
