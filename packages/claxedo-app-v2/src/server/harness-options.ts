import { fetchQuery } from "./fetch-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { FetchQuery, HarnessOptions } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessOptionsFromWire } from "./wire/harness-options"
import { harnessSelectionQuery } from "./wire/harness-selection"

const HARNESS_OPTIONS_PATH = "/api/claxedo/agent-config/harness/options"

export function harnessQueries(transport: Transport, workspaces: Workspaces) {
  return {
    options: (placementId: PlacementId, harness: string): FetchQuery<HarnessOptions> =>
      fetchQuery(queryKeys.harnessOptions(transport.serverUrl, placementId, harness), async () => {
        const { workspaceId } = await workspaces.route(placementId)
        const path = withQuery(HARNESS_OPTIONS_PATH, { workspaceId, ...harnessSelectionQuery(harness) })
        return harnessOptionsFromWire(await transport.json<unknown>(path), harness)
      }),
  }
}
