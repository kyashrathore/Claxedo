import type { Config } from "@opencode-ai/sdk/v2/client"
import { queryKeys, workspaceQueryKey } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"

/**
 * The one reader of a directory's config cache.
 *
 * `workspace` is the RESOLVED workspace identity the entry was written under —
 * the config belongs to the machine serving that workspace, and a read taken
 * before resolution must not be answered with the resolved machine's file (or
 * the other way round). `configQuery` in `features/session/data/query/directory.ts`
 * is the writer; both build the key through `workspaceQueryKey` so they cannot
 * disagree about its shape.
 */
type ConfigWorkspace = Parameters<typeof workspaceQueryKey>[0]

export function directoryConfigQuery(
  baseUrl: string | undefined,
  directory: string,
  workspace?: ConfigWorkspace,
) {
  return {
    queryKey: queryKeys.directory.config(baseUrl, directory, workspaceQueryKey(workspace)),
    // as-any: disabled query exists only for the cache key; data is populated elsewhere.
    queryFn: async () => undefined as unknown as Config,
    enabled: false,
  }
}

export function directoryConfig(
  baseUrl: string | undefined,
  directory: string,
  workspace?: ConfigWorkspace,
) {
  return queryClient.getQueryData<Config>(
    queryKeys.directory.config(baseUrl, directory, workspaceQueryKey(workspace)),
  )
}
