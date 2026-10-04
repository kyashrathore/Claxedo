import { fetchQuery } from "./fetch-query"
import { sessionId, type PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import { responseError } from "./errors"
import type { HarnessOptions } from "./harness-types"
import type { FetchQuery, SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessCommandQuery } from "./harness-commands"
import { readStopsBackgroundTasks } from "./session-stop"
import { harnessOptionsFromWire } from "./wire/harness-options"
import { harnessSelectionQuery } from "./wire/harness-selection"

const HARNESS_OPTIONS_PATH = "/api/claxedo/agent-config/harness/options"

export type HarnessOptionsRequest = {
  readonly placementId: PlacementId
  readonly harness: string
  readonly sessionId?: string
  readonly model?: string
}

export async function readHarnessOptions(transport: Transport, workspaces: Workspaces, request: HarnessOptionsRequest): Promise<HarnessOptions> {
  const route = await workspaces.route(request.sessionId ? { placementId: request.placementId, sessionId: sessionId(request.sessionId) } : request.placementId)
  const selection = harnessSelectionQuery(request.harness)
  if (route.remote) {
    const path = request.sessionId ? `/session/${encodeURIComponent(request.sessionId)}/config-options` : "/api/wr/harness-config-options"
    return harnessOptionsFromWire(await transport.runtimeJson(route, withQuery(path, { ...selection, model: request.model })))
  }
  const response = await transport.request(withQuery(HARNESS_OPTIONS_PATH, {
    workspaceId: route.workspaceId,
    ...selection,
    sessionId: request.sessionId,
    model: request.model,
  }))
  if (!response.ok) throw await responseError(response, "Model options")
  return harnessOptionsFromWire(await response.json())
}

export function harnessQueries(transport: Transport, workspaces: Workspaces) {
  return {
    options: (placementId: PlacementId, harness: string): FetchQuery<HarnessOptions> =>
      fetchQuery(queryKeys.harnessOptions(transport.serverUrl, placementId, harness), () => readHarnessOptions(transport, workspaces, { placementId, harness })),
    commands: harnessCommandQuery(transport, workspaces),
    stopsBackgroundTasks: (ref: SessionLocation): FetchQuery<boolean> =>
      fetchQuery(queryKeys.stopsBackgroundTasks(transport.serverUrl, ref.placementId, ref.sessionId), async () => readStopsBackgroundTasks(transport, await workspaces.route(ref), ref)),
  }
}
