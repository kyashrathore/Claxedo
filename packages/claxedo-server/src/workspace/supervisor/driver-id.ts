import { loadUserConfig, sandboxDriverConfig } from "@claxedo/server-core/agent-config/index"
import { defaultSandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import { isSandboxDriverID, type SandboxDriverID } from "@claxedo/sandbox-contract"
import { needWorkspaceSupervisorOptions } from "./options"
import type { WorkspaceRuntimeState } from "./store"

/**
 * The driver this workspace's sandbox runs on.
 *
 * A leaf of its own because both the provisioning path and the config push need
 * it, and importing it from either of those puts the two in a cycle.
 *
 * A row may name a provisioner this machine cannot drive — `fetch` is a hosted
 * deployment's bridge, not a catalog driver — so the stored id is used only
 * when the catalog implements it.
 */
export async function supervisorSandboxDriverId(state: WorkspaceRuntimeState): Promise<SandboxDriverID> {
  const stored = state.ws.driver
  return (isSandboxDriverID(stored) ? stored : undefined)
    ?? needWorkspaceSupervisorOptions().default_sandbox_driver
    ?? defaultSandboxDriverID(sandboxDriverConfig(await loadUserConfig()))
}
