import { fetchQuery } from "./fetch-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import { responseError } from "./errors"
import type { FetchQuery, HarnessLogin, HarnessOptions } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessOptionsFromWire } from "./wire/harness-options"
import { harnessSelectionQuery } from "./wire/harness-selection"
import { harnessLoginsFromWire, MACHINE_LOGINS_PATH, MACHINE_LOGINS_UNSUPPORTED } from "./wire/machine-logins"

const HARNESS_OPTIONS_PATH = "/api/claxedo/agent-config/harness/options"

async function readLogins(transport: Transport): Promise<readonly HarnessLogin[]> {
  const response = await transport.request(MACHINE_LOGINS_PATH)
  if (response.status === MACHINE_LOGINS_UNSUPPORTED) return []
  if (!response.ok) throw await responseError(response, "Machine logins")
  return harnessLoginsFromWire(await response.json())
}

export function harnessQueries(transport: Transport, workspaces: Workspaces) {
  return {
    logins: (): FetchQuery<readonly HarnessLogin[]> => fetchQuery(queryKeys.harnessLogins(transport.serverUrl), () => readLogins(transport)),
    options: (placementId: PlacementId, harness: string): FetchQuery<HarnessOptions> =>
      fetchQuery(queryKeys.harnessOptions(transport.serverUrl, placementId, harness), async () => {
        const { workspaceId } = await workspaces.route(placementId)
        const path = withQuery(HARNESS_OPTIONS_PATH, { workspaceId, ...harnessSelectionQuery(harness) })
        return harnessOptionsFromWire(await transport.json<unknown>(path), harness)
      }),
  }
}
