import { resolveWorkspaceRuntime } from "../../cloud/workspace-runtime-store"
import { queryClient } from "./query-client"
import { queryKeys } from "./keys"

type FetchQueryInput = Parameters<typeof queryClient.fetchQuery>[0]

export async function ensureLocalProject(input: {
  baseUrl?: string
  request?: typeof fetch
  directory: string
  projectsQuery: FetchQueryInput
}) {
  const directory = input.directory.trim()
  if (!directory) return undefined
  const workspace = await resolveWorkspaceRuntime({
    baseUrl: input.baseUrl,
    request: input.request,
    directory,
    create: true,
  })
  if (!workspace) throw new Error("Failed to ensure workspace")
  queryClient.invalidateQueries({
    queryKey: queryKeys.runtime.workspace({
      baseUrl: input.baseUrl,
      directory,
    }),
  })
  queryClient.invalidateQueries({ queryKey: input.projectsQuery.queryKey })
  return queryClient.fetchQuery(input.projectsQuery)
}
