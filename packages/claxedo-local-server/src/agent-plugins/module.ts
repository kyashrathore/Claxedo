import { agentPluginsModule, type AgentPluginsModule } from "@claxedo/server-core/agent-plugins/module"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { UnsignedAgentPluginActivationStore } from "@claxedo/server-core/agent-plugins/activation/store"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import { LocalAgentPluginActivationRoutes } from "./activation/routes"
import { SignedAgentPluginRuntimeRoutes } from "./activation/signed-runtime-routes"
import { MachineInstalledDiscoveryRoutes } from "./discovery/routes"
import type { LocalAgentPluginsComposition } from "./local-composition"

export function createLocalAgentPluginsModule(input: {
  sources: CatalogSourceProvider
  artifacts: AgentPluginArtifactStore
  activations: UnsignedAgentPluginActivationStore
  reconcile: AgentPluginReconcilePort
  /** The signed world's loopback surface; a composition without an account seam passes none. */
  signedRuntime?: LocalAgentPluginsComposition["signedRuntime"]
}): AgentPluginsModule {
  const routes = LocalAgentPluginActivationRoutes(input)
  if (input.signedRuntime) routes.route("/signed-runtime", SignedAgentPluginRuntimeRoutes(input.signedRuntime))
  routes.route("/machine-installed", MachineInstalledDiscoveryRoutes())
  return agentPluginsModule(routes)
}
