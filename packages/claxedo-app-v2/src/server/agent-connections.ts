import type { QueryClient } from "@tanstack/solid-query"
import { decodeHarnessConnectionsCatalog, type HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery } from "./types"

const AGENT_CONNECTIONS_PATH = "/api/claxedo/agent-config/connections"

export type AgentConnectionsQueries = { readonly list: () => FetchQuery<HarnessConnectionsCatalog> }

export type AgentConnectionsApi = { readonly remove: (connectionId: string) => Promise<void> }

export function agentConnectionQueries(transport: Transport): AgentConnectionsQueries {
  return {
    list: () => fetchQuery(queryKeys.agentConnections(transport.serverUrl), async () => decodeHarnessConnectionsCatalog(await transport.json<unknown>(AGENT_CONNECTIONS_PATH))),
  }
}

export function createAgentConnectionsApi(transport: Transport, queryClient: QueryClient): AgentConnectionsApi {
  return {
    remove: async (connectionId) => {
      await transport.json<unknown>(`${AGENT_CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}`, { method: "DELETE" })
      await queryClient.invalidateQueries({ queryKey: queryKeys.agentConnections(transport.serverUrl) })
    },
  }
}
