import { queryOptions } from "@tanstack/solid-query"
import { queryKeys } from "@/platform/query/keys"

type FileStatusClient<TStatus> = {
  file: {
    status: (
      input?: undefined,
      options?: { signal?: AbortSignal },
    ) => Promise<{ data?: TStatus[] }>
  }
}

/** One cache identity and one authoritative fetch path for workspace change status. */
export function workspaceFileStatusQueryOptions<TStatus>(input: {
  baseUrl?: string
  directoryPath: string
  workspaceKey?: string
  client: FileStatusClient<TStatus>
}) {
  return queryOptions({
    queryKey: queryKeys.directory.fileStatus(input.baseUrl, input.directoryPath, input.workspaceKey),
    queryFn: ({ signal }) => input.client.file.status(undefined, { signal }).then((response) => response.data ?? []),
  })
}
