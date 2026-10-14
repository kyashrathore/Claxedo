import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { toAppError, useServer } from "@/server"
import { machineTimeSince, usageRequest, type MachineTimeLoad, type UsageDays, type UsageLoad, type UsageOptions, type UsageRead } from "./model"

function readOf<Data>(query: { readonly data: Data | undefined; readonly isError: boolean; readonly error: unknown }): UsageRead<Data> {
  if (query.data !== undefined) return { kind: "ready", data: query.data }
  if (query.isError) return { kind: "failed", error: toAppError(query.error) }
  return { kind: "loading" }
}

export type UsageSummaryRead = {
  readonly load: Accessor<UsageLoad>
  readonly fetching: Accessor<boolean>
  readonly refresh: () => void
}

export function useUsageSummary(options: Accessor<UsageOptions>, enabled: Accessor<boolean>): UsageSummaryRead {
  const server = useServer()
  const now = Date.now()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const query = useQuery(() => ({ ...server.queries.usage.summary(usageRequest(options(), now, timeZone)), enabled: enabled() }))
  const load = createMemo((): UsageLoad => readOf(query))
  return {
    load,
    fetching: () => query.isFetching,
    refresh: () => void query.refetch(),
  }
}

export type MachineTimeRead = {
  readonly load: Accessor<MachineTimeLoad>
  readonly refresh: () => void
}

export function useMachineTime(days: Accessor<UsageDays>): MachineTimeRead {
  const server = useServer()
  const query = useQuery(() => server.queries.usage.machineTime(machineTimeSince(days(), Date.now())))
  const load = createMemo((): MachineTimeLoad => readOf(query))
  return { load, refresh: () => void query.refetch() }
}
