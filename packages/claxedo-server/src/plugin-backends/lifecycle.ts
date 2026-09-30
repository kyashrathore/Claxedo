import type { D1Database } from "@cloudflare/workers-types"
import { deletePluginBackendActivation, writePluginBackendActivation } from "./activations"
import { pluginSupervisor, type PluginSupervisorNamespace } from "./supervisor.cf"

export type PluginBackendLifecyclePorts = { database: D1Database; supervisors: PluginSupervisorNamespace }

/**
 * Activation and deactivation write the organization's row and then tell its
 * supervisor, so objects running the previous configuration stop now rather
 * than at the next request.
 */
export async function activatePluginBackend(
  ports: PluginBackendLifecyclePorts,
  input: Parameters<typeof writePluginBackendActivation>[1],
): Promise<void> {
  await writePluginBackendActivation(ports.database, input)
  await pluginSupervisor(ports.supervisors, input.orgId).refresh({ orgId: input.orgId, pluginId: input.manifest.id })
}

export async function deactivatePluginBackend(ports: PluginBackendLifecyclePorts, orgId: string, pluginId: string): Promise<void> {
  await deletePluginBackendActivation(ports.database, orgId, pluginId)
  await pluginSupervisor(ports.supervisors, orgId).refresh({ orgId, pluginId })
}
