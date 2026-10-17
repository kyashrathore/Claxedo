import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { AccountSpendReport, AccountSpendRequest, MachineTime, UsageRequest, UsageSummary } from "./usage-types"
import { accountSpendFromWire, machineTimeFromWire, usageSummaryFromWire } from "./wire/usage"

function usageQuery(input: UsageRequest) {
  const filters = Object.fromEntries(Object.entries(input.filters ?? {}).flatMap(([dimension, value]) => (value ? [[`filter_${dimension}`, value]] : [])))
  return {
    since: input.since,
    until: input.until,
    timezone: input.timeZone,
    view: input.view,
    group: input.group,
    metric: input.metric,
    after: input.after,
    model_after: input.modelAfter,
    limit: input.limit,
    refresh_nonce: input.refreshNonce,
    ...filters,
  }
}

export function usageQueries(transport: Transport) {
  return {
    summary: (input: UsageRequest) =>
      fetchQuery<UsageSummary>(queryKeys.usage(transport.serverUrl, input), () =>
        transport.json(withQuery("/api/claxedo/usage", usageQuery(input))).then(usageSummaryFromWire),
      ),
    machineTime: (since: number) =>
      fetchQuery<MachineTime>(queryKeys.machineTime(transport.serverUrl, since), () =>
        transport.json(withQuery("/api/claxedo/usage/machine-time", { since })).then(machineTimeFromWire),
      ),
    accountSpend: (input: AccountSpendRequest) =>
      fetchQuery<AccountSpendReport>(queryKeys.accountSpend(transport.serverUrl, input), () =>
        transport.json(withQuery("/api/claxedo/usage/credentials", { since: input.since, until: input.until, scope: input.scope })).then(accountSpendFromWire),
      ),
  }
}
