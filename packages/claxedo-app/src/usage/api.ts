import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useAccess } from "@/access"
import { useAuth } from "@/auth"
import { toAppError, useServer, type AccountSpendScope } from "@/server"
import { accountSpendRequest } from "./account-spend"
import { machineTimeSince, usageRequest, type AccountSpendLoad, type MachineTimeLoad, type UsageDays, type UsageLoad, type UsageOptions, type UsageRead } from "./model"

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

export type AccountSpendRead = {
  readonly load: Accessor<AccountSpendLoad>
  readonly refresh: () => void
}

export function useAccountSpend(days: Accessor<UsageDays>, scope: Accessor<AccountSpendScope>): AccountSpendRead {
  const server = useServer()
  const now = Date.now()
  const query = useQuery(() => server.queries.usage.accountSpend(accountSpendRequest(days(), scope(), now)))
  const load = createMemo((): AccountSpendLoad => readOf(query))
  return { load, refresh: () => void query.refetch() }
}

export function useManagesTeamKeys(): Accessor<boolean> {
  const server = useServer()
  const auth = useAuth()
  const access = useAccess()
  const memberships = useQuery(() => server.queries.organizations.mine())
  const membership = () => {
    const state = auth.state()
    const orgId = state.kind === "signedIn" ? state.user.orgId : undefined
    return memberships.data?.find((row) => orgId === undefined || row.orgId === orgId)
  }
  return () => access.can("usage.teamSpend", { role: membership()?.role })
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
