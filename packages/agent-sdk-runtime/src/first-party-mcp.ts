import type { McpServer } from "@agentclientprotocol/sdk"
import { isRecord } from "@claxedo/agent-runtime-contract"

/**
 * The key a runtime config record carries its first-party MCP provider under.
 * The provider rides `applyConfig` beside `mcp` because the entry it produces
 * differs per session — its URL names the session — while the config snapshot
 * is workspace-grained; the driver asks for the entry at each launch instead.
 * The stamp that decides whether config changed reads `mcp` only, so a
 * credential refresh inside the provider never restarts a harness.
 */
export const FIRST_PARTY_MCP_CONFIG_KEY = "firstPartyMcp"

export type FirstPartyMcpServer = {
  name: string
  url: string
  headers: Record<string, string>
}

export type FirstPartyMcpProvider = {
  server(sessionId: string): FirstPartyMcpServer
}

export function firstPartyMcpProvider(config: Record<string, unknown>): FirstPartyMcpProvider | undefined {
  const candidate = config[FIRST_PARTY_MCP_CONFIG_KEY]
  if (!isRecord(candidate) || typeof candidate.server !== "function") return undefined
  const server = candidate.server as (sessionId: string) => unknown
  return {
    server(sessionId) {
      const entry = server(sessionId)
      if (
        !isRecord(entry)
        || typeof entry.name !== "string" || !entry.name
        || typeof entry.url !== "string" || !entry.url
        || !isRecord(entry.headers)
        || Object.values(entry.headers).some((value) => typeof value !== "string")
      ) {
        throw new Error("First-party MCP provider returned an invalid server entry")
      }
      return { name: entry.name, url: entry.url, headers: entry.headers as Record<string, string> }
    },
  }
}

export function acpFirstPartyMcpServer(server: FirstPartyMcpServer): McpServer {
  return {
    type: "http",
    name: server.name,
    url: server.url,
    headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
  }
}
