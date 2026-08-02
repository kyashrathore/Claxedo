import type { FileContent, FileNode } from "@opencode-ai/sdk/v2"
import { queryClient } from "@/platform/query/query-client"

export function fileReadRequestQueryKey(directory: string, file: string) {
  return ["shell", "file-read-request", directory, file] as const
}

export function fileTreeRequestQueryKey(directory: string, dir: string) {
  return ["shell", "file-tree-request", directory, dir] as const
}

export function cachedFileReadRequest(input: {
  directory: string
  file: string
  force?: boolean
  read: () => Promise<FileContent | undefined>
}) {
  const queryKey = fileReadRequestQueryKey(input.directory, input.file)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.read,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function cachedFileTreeRequest(input: {
  directory: string
  dir: string
  force?: boolean
  list: () => Promise<FileNode[]>
}) {
  const queryKey = fileTreeRequestQueryKey(input.directory, input.dir)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.list,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function clearFileRequestCache(directory?: string) {
  queryClient.removeQueries({
    queryKey: ["shell"],
    predicate: (query) => {
      if (query.queryKey[1] !== "file-read-request" && query.queryKey[1] !== "file-tree-request") return false
      return directory === undefined || query.queryKey[2] === directory
    },
  })
}
