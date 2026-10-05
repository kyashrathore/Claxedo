import { fetchQuery } from "./fetch-query"
import { sessionId, type PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import { responseError, ServerError } from "./errors"
import { HARNESS_NEEDS_BROKERING } from "@claxedo/agent-runtime-contract"
import type { HarnessOptions } from "./harness-types"
import type { FetchQuery, SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessCommandQuery } from "./harness-commands"
import { readStopsBackgroundTasks } from "./session-stop"
import { harnessOptionsFromWire, unavailableHereOptionsFromWire } from "./wire/harness-options"
import { harnessSelectionQuery } from "./wire/harness-selection"

const HARNESS_OPTIONS_PATH = "/api/claxedo/agent-config/harness/options"

export type HarnessOptionsRequest = {
  readonly placementId: PlacementId
  readonly harness: string
  readonly sessionId?: string
  readonly model?: string
}

/** A cloud draft asks the control plane first: it answers Pi's models itself and refuses a harness its sandbox provider cannot run; 204 leaves the runtime to answer. */
function draftServedByControlPlane(workspaces: Workspaces, request: HarnessOptionsRequest) {
  return !request.sessionId && "nativeHarness" in harnessSelectionQuery(request.harness) && workspaces.byId(request.placementId)?.kind === "cloud"
}

async function readOptionsRoute(transport: Transport, query: Record<string, string | undefined>): Promise<HarnessOptions | undefined> {
  const response = await transport.request(withQuery(HARNESS_OPTIONS_PATH, query))
  if (response.status === 204) return undefined
  if (!response.ok) throw await responseError(response, "Model options")
  return harnessOptionsFromWire(await response.json())
}

export async function readHarnessOptions(transport: Transport, workspaces: Workspaces, request: HarnessOptionsRequest): Promise<HarnessOptions> {
  try {
    return await readOptions(transport, workspaces, request)
  } catch (error) {
    if (error instanceof ServerError && error.code === HARNESS_NEEDS_BROKERING) return unavailableHereOptionsFromWire(error.details)
    throw error
  }
}

async function readOptions(transport: Transport, workspaces: Workspaces, request: HarnessOptionsRequest): Promise<HarnessOptions> {
  const selection = harnessSelectionQuery(request.harness)
  if (draftServedByControlPlane(workspaces, request)) {
    const answered = await readOptionsRoute(transport, { ...selection, workspaceId: request.placementId, model: request.model })
    if (answered) return answered
  }
  const route = await workspaces.route(request.sessionId ? { placementId: request.placementId, sessionId: sessionId(request.sessionId) } : request.placementId)
  if (route.remote) {
    const path = request.sessionId ? `/session/${encodeURIComponent(request.sessionId)}/config-options` : "/api/wr/harness-config-options"
    return harnessOptionsFromWire(await transport.runtimeJson(route, withQuery(path, { ...selection, model: request.model })))
  }
  return (await readOptionsRoute(transport, { workspaceId: route.workspaceId, ...selection, sessionId: request.sessionId, model: request.model })) ?? harnessOptionsFromWire(undefined)
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
