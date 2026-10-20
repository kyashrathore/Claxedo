import type { D1Database } from "@cloudflare/workers-types"
import { pluginSupervisor, type PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import { writePluginBackendActivation, writePluginBackendDeactivation } from "./activations"

export type PluginBackendLifecyclePorts = { database: D1Database; supervisors: PluginSupervisorNamespace }

/**
 * Activation and deactivation write the organization's row and then tell the
 * plugin's supervisor, so objects running the previous configuration stop now
 * rather than at the next request.
 */
export async function activatePluginBackend(
  ports: PluginBackendLifecyclePorts,
  input: Parameters<typeof writePluginBackendActivation>[1],
): Promise<void> {
  await writePluginBackendActivation(ports.database, input)
  const scope = { orgId: input.orgId, pluginId: input.manifest.id }
  await pluginSupervisor(ports.supervisors, scope).refresh(scope)
}

export async function deactivatePluginBackend(
  ports: PluginBackendLifecyclePorts,
  input: Parameters<typeof writePluginBackendDeactivation>[1],
): Promise<void> {
  await writePluginBackendDeactivation(ports.database, input)
  const scope = { orgId: input.orgId, pluginId: input.pluginId }
  await pluginSupervisor(ports.supervisors, scope).refresh(scope)
}
