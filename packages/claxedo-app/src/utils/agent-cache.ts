import type { Agent } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "@claxedo/shared/query/keys"

type AgentClient = {
  app: {
    agents: (input?: { directory?: string }) => Promise<{ data?: Agent[] }>
  }
}

export function directoryAgentsQuery(baseUrl: string | undefined, directory: string, client: AgentClient) {
  return {
    queryKey: queryKeys.directory.agents(baseUrl, directory),
    queryFn: async () => (await client.app.agents({ directory })).data ?? [],
    staleTime: 30_000,
  }
}
