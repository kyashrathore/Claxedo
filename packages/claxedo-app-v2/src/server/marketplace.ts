import { fetchQuery } from "./fetch-query"
import type { ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { MarketplaceCatalog } from "./marketplace-types"

export function marketplaceQueries(transport: Transport) {
  return {
    catalog: (projectId?: ProjectId) =>
      fetchQuery<MarketplaceCatalog>(queryKeys.marketplace(transport.serverUrl, projectId), () =>
        transport.json<MarketplaceCatalog>(withQuery("/api/claxedo/plugins", { project: projectId })),
      ),
  }
}
