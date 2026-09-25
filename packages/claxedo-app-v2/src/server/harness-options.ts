import { fetchQuery } from "./fetch-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import { responseError } from "./errors"
import type { HarnessLogin, HarnessOptions } from "./harness-types"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessOptionsFromWire } from "./wire/harness-options"
import { harnessSelectionQuery } from "./wire/harness-selection"
import { harnessLoginsFromWire, MACHINE_LOGINS_PATH, MACHINE_LOGINS_UNSUPPORTED } from "./wire/machine-logins"

const HARNESS_OPTIONS_PATH = "/api/claxedo/agent-config/harness/options"

/** `model` asks for that model's effort levels; `sessionId` for the harness the session runs. */
export type HarnessOptionsRequest = {
  readonly placementId: PlacementId
  readonly harness: string
  readonly sessionId?: string
  readonly model?: string
}

export async function readHarnessOptions(transport: Transport, workspaces: Workspaces, request: HarnessOptionsRequest): Promise<HarnessOptions> {
  const { workspaceId } = await workspaces.route(request.placementId)
  const response = await transport.request(withQuery(HARNESS_OPTIONS_PATH, {
    workspaceId,
    ...harnessSelectionQuery(request.harness),
    sessionId: request.sessionId,
    model: request.model,
  }))
  if (!response.ok) throw await responseError(response, "Model options")
  return harnessOptionsFromWire(await response.json())
}

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
      fetchQuery(queryKeys.harnessOptions(transport.serverUrl, placementId, harness), () => readHarnessOptions(transport, workspaces, { placementId, harness })),
  }
}
