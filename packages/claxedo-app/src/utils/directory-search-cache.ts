import { queryClient } from "@claxedo/shared/query/query-client"

export type DirectorySearchEntry = {
  name: string
  absolute: string
}

export function directoryChildrenRequestQueryKey(input: { serverUrl?: string; directory: string }) {
  return ["shell", "directory-children-request", input.serverUrl ?? "", input.directory] as const
}

export function cachedDirectoryChildrenRequest(input: {
  serverUrl?: string
  directory: string
  force?: boolean
  list: () => Promise<DirectorySearchEntry[]>
}) {
  const queryKey = directoryChildrenRequestQueryKey(input)
  if (input.force) queryClient.removeQueries({ queryKey, exact: true })
  return queryClient.fetchQuery({
    queryKey,
    queryFn: input.list,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function clearDirectorySearchCache(serverUrl?: string) {
  queryClient.removeQueries({
    queryKey: ["shell", "directory-children-request"],
    predicate: (query) => serverUrl === undefined || query.queryKey[2] === serverUrl,
  })
}
