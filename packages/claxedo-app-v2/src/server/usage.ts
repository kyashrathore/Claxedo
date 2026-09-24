import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { UsageRequest, UsageSummary } from "./usage-types"

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
    ...filters,
  }
}

export function usageQueries(transport: Transport) {
  return {
    summary: (input: UsageRequest) =>
      fetchQuery<UsageSummary>(queryKeys.usage(transport.serverUrl, input), () =>
        transport.json<UsageSummary>(withQuery("/api/claxedo/usage", usageQuery(input))),
      ),
  }
}
