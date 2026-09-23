import type { PluginCandidate } from "./api"
/**
 * The MCP connection port the Agent Plugins surfaces speak to.
 *
 * It lives beside the catalog transport rather than inside one component
 * because the Directory's detail pane and the install sheet both drive it, and
 * `app/composition/agent-plugin-connections.ts` implements it over the app's
 * single integrations request.
 */
export type AgentPluginConnectionSummary = {
  id: string
  integrationId: string
  scope: "personal" | "team"
  status: "connected" | "degraded" | "broken"
}

export type AgentPluginConnectionPort = {
  load(): Promise<{ connections: AgentPluginConnectionSummary[] }>
  open(input: {
    integrationId: string
    name: string
    scope: "personal" | "team"
    issuer?: string
    teamScopeEnabled: boolean
    onConnected(): void | Promise<void>
  }): void
  disconnect(connectionId: string): Promise<void>
}

/** What a connection's status is called wherever a plugin's MCP server is shown. */
export const AGENT_PLUGIN_CONNECTION_STATUS = {
  connected: "connected",
  degraded: "needs reconnection",
  broken: "missing credential",
} as const

export type OAuthServer = {
  name: string
  integrationId: string
  issuers?: readonly string[]
}

/** The candidate's MCP servers that need a connected account. One owner; the Directory and the install sheet both read it. */
export function oauthServers(plugin: PluginCandidate): OAuthServer[] {
  return plugin.mcpServers.flatMap((server) => server.authentication.state === "oauth"
    ? [{
        name: server.name,
        integrationId: server.authentication.integrationId,
        ...(server.authentication.issuers ? { issuers: server.authentication.issuers } : {}),
      }]
    : [])
}
