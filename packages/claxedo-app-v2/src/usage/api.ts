import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer } from "@/server"
import { usageRequest, type UsageLoad, type UsageOptions } from "./model"

export type UsageSummaryRead = {
  readonly load: Accessor<UsageLoad>
  readonly fetching: Accessor<boolean>
  readonly refresh: () => void
}

export function useUsageSummary(options: Accessor<UsageOptions>): UsageSummaryRead {
  const server = useServer()
  const now = Date.now()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const query = useQuery(() => server.queries.usage.summary(usageRequest(options(), now, timeZone)))
  const load = createMemo((): UsageLoad => {
    if (query.data !== undefined) return { kind: "ready", summary: query.data }
    if (query.isError) return { kind: "failed", error: toAppError(query.error) }
    return { kind: "loading" }
  })
  return {
    load,
    fetching: () => query.isFetching,
    refresh: () => void query.refetch(),
  }
}
