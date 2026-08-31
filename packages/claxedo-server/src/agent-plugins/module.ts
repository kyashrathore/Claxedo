import { agentPluginsModule, type AgentPluginsModule } from "@claxedo/server-core/agent-plugins/module"
import type { SignedAgentPluginActivationStore } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { HostedAgentPluginRoutes } from "./routes"
import type { Hono } from "hono"
import type { AgentPluginMcpCatalogAuthenticationResolver } from "./mcp/catalog-auth"
import type { HostedMcpClientMetadata } from "./mcp/client-metadata"

/** One hosted feature composition. No generic hosted entry statically imports this module. */
export function hostedAgentPluginsModule(input: {
  services: ControlPlaneServices
  sources(auth: SignedControlPlaneAuth): CatalogSourceProvider
  activations: SignedAgentPluginActivationStore
  artifacts: AgentPluginArtifactStore
  reconcile: AgentPluginReconcilePort
  mcpAuthentication?: AgentPluginMcpCatalogAuthenticationResolver
  mcpClientMetadata?: HostedMcpClientMetadata
  mcpGatewayRoutes?: Hono
}): AgentPluginsModule {
  const routes = HostedAgentPluginRoutes(input)
  if (input.mcpGatewayRoutes) routes.route("/mcp", input.mcpGatewayRoutes)
  return agentPluginsModule(routes)
}
