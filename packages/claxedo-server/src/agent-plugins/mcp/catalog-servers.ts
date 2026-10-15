import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import type { AgentPluginMcpServer, ValidatedAgentPlugin } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { AgentPluginMcpCatalogAuthentication, AgentPluginMcpCatalogAuthenticationResolver } from "./catalog-auth"
import { SESSION_HOST_HARNESS, sandboxCarriesGatewayCredential } from "./gateway-reach"

/** What a cloud workspace of the caller's organization can be delivered, as the runtime preparation decides it. */
export type CatalogCloudDelivery = {
  /** The commands the sandbox image ships. */
  imageCommands: readonly string[]
  /** How the driver the organization's new workspaces run on brokers secrets. */
  secretBrokering: SandboxSecretBrokering
}

export type CatalogCloudReach =
  | { state: "gateway" | "image-command" }
  | { state: "gateway"; onlyHarnesses: readonly string[]; reason: "secret_brokering_unsupported" }
  | { state: "unavailable"; reason: string }

/**
 * How one server reaches a cloud sandbox: HTTP through the plugin gateway, a
 * local command only when the image ships it, and otherwise not at all. A
 * server that needs a minted credential reaches only the session host when
 * the organization's driver cannot carry it.
 */
function cloudReach(server: AgentPluginMcpServer, authentication: AgentPluginMcpCatalogAuthentication | undefined,
  delivery: CatalogCloudDelivery): CatalogCloudReach {
  if (server.type === "streamable-http") {
    if (authentication?.state === "public" || sandboxCarriesGatewayCredential(delivery.secretBrokering)) return { state: "gateway" }
    return { state: "gateway", onlyHarnesses: [SESSION_HOST_HARNESS], reason: "secret_brokering_unsupported" }
  }
  if (server.type !== "stdio") return { state: "unavailable", reason: "mcp_transport_unsupported" }
  const name = server.command.split("/").at(-1) ?? server.command
  return delivery.imageCommands.includes(name)
    ? { state: "image-command" }
    : { state: "unavailable", reason: "mcp_command_not_in_image" }
}

export async function catalogMcpServers(input: {
  pluginInstanceId: string
  mcp: ValidatedAgentPlugin["mcp"]
  authentication?: AgentPluginMcpCatalogAuthenticationResolver
  delivery: CatalogCloudDelivery
}) {
  if (input.mcp.status !== "valid") return []
  return Promise.all(input.mcp.servers.map(async (server) => {
    if (server.type === "stdio") {
      return { name: server.name, type: server.type, authentication: { state: "local" as const }, cloud: cloudReach(server, undefined, input.delivery) }
    }
    if (server.type === "sse") {
      return { name: server.name, type: server.type, authentication: { state: "unavailable" as const, reason: "mcp_transport_unsupported" },
        cloud: cloudReach(server, undefined, input.delivery) }
    }
    const authentication: AgentPluginMcpCatalogAuthentication = input.authentication
      ? await input.authentication({ pluginInstanceId: input.pluginInstanceId, server })
      : { state: "unavailable", reason: "mcp_auth_management_unavailable" }
    return { name: server.name, type: server.type, authentication, cloud: cloudReach(server, authentication, input.delivery) }
  }))
}
