import type { Config } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "@/shared/query/keys"
import { queryClient } from "@/shared/query/query-client"

export function directoryConfigQuery(baseUrl: string | undefined, directory: string) {
  return {
    queryKey: queryKeys.directory.config(baseUrl, directory),
    // as-any: disabled query exists only for the cache key; data is populated elsewhere.
    queryFn: async () => undefined as unknown as Config,
    enabled: false,
  }
}

export function directoryConfig(baseUrl: string | undefined, directory: string) {
  return queryClient.getQueryData<Config>(queryKeys.directory.config(baseUrl, directory))
}
