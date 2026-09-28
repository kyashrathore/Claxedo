import type { RuntimeCommand } from "@claxedo/agent-runtime-contract"
import { fetchQuery } from "./fetch-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"
import { runtimeCommandsFromWire } from "./wire/harness-commands"
import { harnessSelectionQuery } from "./wire/harness-selection"

const COMMANDS_PATH = "/api/wr/command"

export async function readHarnessCommands(transport: Transport, workspaces: Workspaces, placementId: PlacementId, harness: string): Promise<readonly RuntimeCommand[]> {
  const route = await workspaces.route(placementId)
  return runtimeCommandsFromWire(await transport.runtimeJson<unknown>(route, withQuery(COMMANDS_PATH, harnessSelectionQuery(harness))))
}

export function harnessCommandQuery(transport: Transport, workspaces: Workspaces) {
  return (placementId: PlacementId, harness: string): FetchQuery<readonly RuntimeCommand[]> =>
    fetchQuery(queryKeys.harnessCommands(transport.serverUrl, placementId, harness), () => readHarnessCommands(transport, workspaces, placementId, harness))
}
