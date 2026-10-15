import type { QueryClient } from "@tanstack/solid-query"
import { queryKeys } from "./query-keys"

export type AccountWrite = <T>(run: () => Promise<T>) => Promise<T>

export type AccountWrites = { readonly refresh: () => Promise<void>; readonly write: AccountWrite }

export function accountWrites(queryClient: QueryClient, server: string): AccountWrites {
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.accounts(server) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.providerCatalogs(server) })
  }
  const write: AccountWrite = async (run) => {
    try {
      return await run()
    } finally {
      await refresh()
    }
  }
  return { refresh, write }
}
