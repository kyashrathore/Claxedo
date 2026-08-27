import { queryOptions, skipToken, type UndefinedInitialDataOptions } from "@tanstack/solid-query"

export type ParkedPaneQueryReason = "inactive" | "no-session"
export type PaneQueryOptions<T> = ReturnType<UndefinedInitialDataOptions<T>>

/**
 * Move a retained pane's QueryObserver onto an explicit non-fetching key.
 * This is observer lifecycle state, not a synthesized resource identity.
 */
export function parkedPaneQueryOptions<T>(resource: string, reason: ParkedPaneQueryReason): PaneQueryOptions<T> {
  return queryOptions<T>({
    queryKey: ["shell", "pane-observer", { state: "parked", reason }, resource] as const,
    queryFn: skipToken,
    enabled: false,
  })
}

export function paneQueryOptions<T>(options: unknown): PaneQueryOptions<T> {
  return options as PaneQueryOptions<T>
}
