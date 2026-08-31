import { agentPluginsModule, type AgentPluginsModule } from "@claxedo/server-core/agent-plugins/module"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { UnsignedAgentPluginActivationStore } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import { LocalAgentPluginActivationRoutes } from "./activation/routes"

export function createLocalAgentPluginsModule(input: {
  sources: CatalogSourceProvider
  artifacts: AgentPluginArtifactStore
  activations: UnsignedAgentPluginActivationStore
  reconcile: AgentPluginReconcilePort
}): AgentPluginsModule {
  return agentPluginsModule(LocalAgentPluginActivationRoutes(input))
}
