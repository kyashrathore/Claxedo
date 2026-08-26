import type { Accessor } from "solid-js"
import type { useSDK } from "@/features/session/app-ports"
import { createAsyncState } from "@/lib/async-state"
import { queryClient } from "@/platform/query/query-client"
import { commandListQuery } from "../data/query/shell"

export function createComposerCustomCommands(
  directory: Accessor<string>,
  sdk: ReturnType<typeof useSDK>,
  request: typeof fetch,
) {
  return createAsyncState(() => {
    const value = directory()
    return queryClient.fetchQuery(
      commandListQuery({
        baseUrl: sdk.url,
        directory: value,
        request,
        workspace: sdk.workspace(value),
        client: sdk.createClient({ directory: value }),
      }),
    )
  })
}
