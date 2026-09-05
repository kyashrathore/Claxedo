import type { AgentPluginHttpServer } from "@claxedo/server-core/agent-plugins/catalog/types"
import {
  McpOAuthDiscoveryError,
  discoverMcpOAuth,
} from "@claxedo/server-core/agent-plugins/mcp/discovery"
import { mcpOAuthIntegrationId } from "@claxedo/server-core/agent-plugins/mcp/integration"
import type { HostedMcpOAuthConfiguration } from "./connections"

export type AgentPluginMcpCatalogAuthentication =
  | { state: "public" }
  | { state: "oauth"; integrationId: string; issuers?: readonly string[] }
  | { state: "unavailable"; reason: string }

export type AgentPluginMcpCatalogAuthenticationResolver = (input: {
  pluginInstanceId: string
  server: AgentPluginHttpServer
}) => Promise<AgentPluginMcpCatalogAuthentication>

/**
 * Read-only MCP authentication projection for catalog presentation. It owns
 * no connection or OAuth state; protected servers still connect exclusively
 * through the existing Connections route family.
 */
export function hostedMcpCatalogAuthentication(
  oauth: HostedMcpOAuthConfiguration,
): AgentPluginMcpCatalogAuthenticationResolver {
  return async ({ pluginInstanceId, server }) => {
    if (server.type !== "streamable-http") {
      return { state: "unavailable", reason: "mcp_transport_unsupported" }
    }
    try {
      const result = await discoverMcpOAuth({
        resourceUrl: server.url,
        fetch: oauth.fetch,
        ...(oauth.preRegistered ? { preRegistered: oauth.preRegistered } : {}),
        ...(oauth.clientIdMetadataDocumentUrl
          ? { clientIdMetadataDocumentUrl: oauth.clientIdMetadataDocumentUrl }
          : {}),
        // A catalog read may therefore REGISTER this deployment's client with a
        // newly seen authorization server. That is the same deployment-wide,
        // idempotent client the connect flow would create moments later; the
        // registry makes the second discovery reuse it rather than repeat it.
        ...(oauth.dynamicRegistration ? { dynamicRegistration: oauth.dynamicRegistration } : {}),
      })
      if (result.status === "public") return { state: "public" }
      return {
        state: "oauth",
        integrationId: await mcpOAuthIntegrationId({ pluginInstanceId, serverName: server.name }),
      }
    } catch (cause) {
      if (cause instanceof McpOAuthDiscoveryError
        && cause.code === "ambiguous-issuer"
        && cause.issuers?.length) {
        return {
          state: "oauth",
          integrationId: await mcpOAuthIntegrationId({ pluginInstanceId, serverName: server.name }),
          issuers: cause.issuers,
        }
      }
      return {
        state: "unavailable",
        reason: cause instanceof McpOAuthDiscoveryError ? cause.code : "mcp_auth_discovery_failed",
      }
    }
  }
}
