import type { HostedAccount } from "./account"
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

type DraftQuery = { readonly nativeHarness: string; readonly workspaceId: string; readonly model?: string }
type DraftReader = (query: DraftQuery) => Promise<HarnessOptions | undefined>

function controlPlaneDraftReader(transport: Transport, account: HostedAccount | undefined): DraftReader | undefined {
  if (account) return async (query) => {
    const answer = await account.run("agentConfig.harness.options", query)
    return answer && harnessOptionsFromWire(answer)
  }
  if (transport.loopback) return undefined
  return (query) => readOptionsRoute(transport, query)
}

async function readOptionsRoute(transport: Transport, query: Record<string, string | undefined>): Promise<HarnessOptions | undefined> {
  const response = await transport.request(withQuery(HARNESS_OPTIONS_PATH, query))
  if (response.status === 204) return undefined
  if (!response.ok) throw await responseError(response, "Model options")
  return harnessOptionsFromWire(await response.json())
}

export async function readHarnessOptions(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined, request: HarnessOptionsRequest): Promise<HarnessOptions> {
  try {
    return await readOptions(transport, workspaces, account, request)
  } catch (error) {
    if (error instanceof ServerError && error.code === HARNESS_NEEDS_BROKERING) return unavailableHereOptionsFromWire(error.details)
    throw error
  }
}

function cloudDraft(workspaces: Workspaces, request: HarnessOptionsRequest, selection: ReturnType<typeof harnessSelectionQuery>): DraftQuery | undefined {
  const nativeHarness = selection.nativeHarness
  if (request.sessionId || !nativeHarness || workspaces.byId(request.placementId)?.kind !== "cloud") return undefined
  return { nativeHarness, workspaceId: request.placementId, ...(request.model ? { model: request.model } : {}) }
}

async function readOptions(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined, request: HarnessOptionsRequest): Promise<HarnessOptions> {
  const selection = harnessSelectionQuery(request.harness)
  const draft = cloudDraft(workspaces, request, selection)
  const answered = draft && await controlPlaneDraftReader(transport, account)?.(draft)
  if (answered) return answered
  const route = await workspaces.route(request.sessionId ? { placementId: request.placementId, sessionId: sessionId(request.sessionId) } : request.placementId)
  if (route.remote) {
    const path = request.sessionId ? `/session/${encodeURIComponent(request.sessionId)}/config-options` : "/api/wr/harness-config-options"
    return harnessOptionsFromWire(await transport.runtimeJson(route, withQuery(path, { ...selection, model: request.model })))
  }
  return (await readOptionsRoute(transport, { workspaceId: route.workspaceId, ...selection, sessionId: request.sessionId, model: request.model })) ?? harnessOptionsFromWire(undefined)
}

export function harnessQueries(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined) {
  return {
    options: (placementId: PlacementId, harness: string): FetchQuery<HarnessOptions> =>
      fetchQuery(queryKeys.harnessOptions(transport.serverUrl, placementId, harness), () => readHarnessOptions(transport, workspaces, account, { placementId, harness })),
    commands: harnessCommandQuery(transport, workspaces),
    stopsBackgroundTasks: (ref: SessionLocation): FetchQuery<boolean> =>
      fetchQuery(queryKeys.stopsBackgroundTasks(transport.serverUrl, ref.placementId, ref.sessionId), async () => readStopsBackgroundTasks(transport, await workspaces.route(ref), ref)),
  }
}
