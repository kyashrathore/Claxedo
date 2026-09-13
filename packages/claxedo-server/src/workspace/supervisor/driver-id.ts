import { loadUserConfig, sandboxDriverConfig } from "@claxedo/server-core/agent-config/index"
import { defaultSandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import { needWorkspaceSupervisorOptions } from "./options"
import type { WorkspaceRuntimeState } from "./store"

/**
 * The driver this workspace's sandbox runs on.
 *
 * A leaf of its own because both the provisioning path and the config push need
 * it, and importing it from either of those puts the two in a cycle.
 */
export async function supervisorSandboxDriverId(state: WorkspaceRuntimeState): Promise<SandboxDriverID> {
  return state.ws.driver
    ?? needWorkspaceSupervisorOptions().default_sandbox_driver
    ?? defaultSandboxDriverID(sandboxDriverConfig(await loadUserConfig()))
}
