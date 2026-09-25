import { loadUserConfig, sandboxDriverConfig } from "@claxedo/server-core/agent-config/index"
import { defaultSandboxDriverID, sandboxDriverCatalog, type SandboxDriverCatalogEntry } from "@claxedo/sandbox-manager/driver-catalog"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import { isSandboxDriverID, type SandboxDriverID } from "@claxedo/sandbox-contract"
import { needWorkspaceSupervisorOptions } from "./options"
import type { WorkspaceRuntimeState } from "./store"
import { getSupervisorSandboxLease } from "../../sandbox/stores/sqlite-supervisor-state"

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

export type SupervisorDriverIdentity =
  | { id: string; entry: SandboxDriverCatalogEntry<string>; driver: SandboxDriver }
  | { id: SandboxDriverID; entry: SandboxDriverCatalogEntry; driver?: never }

export function supervisorDriverIdentity(state: WorkspaceRuntimeState, source: "existing"): Promise<SupervisorDriverIdentity | undefined>
export function supervisorDriverIdentity(state: WorkspaceRuntimeState): Promise<SupervisorDriverIdentity>
export async function supervisorDriverIdentity(state: WorkspaceRuntimeState, source: "existing" | "configured" = "configured"): Promise<SupervisorDriverIdentity | undefined> {
  const injected = needWorkspaceSupervisorOptions().sandboxDriver
  if (injected) {
    if (injected.id !== injected.catalogEntry.id) throw new Error("injected sandbox driver catalog id mismatch")
    return { id: injected.id, entry: injected.catalogEntry, driver: injected }
  }
  const id = source === "existing"
    ? [state.sandbox_target?.driver?.id, state.ws.driver, getSupervisorSandboxLease(state.ws.id)?.driver]
      .find(isSandboxDriverID)
    : await supervisorSandboxDriverId(state)
  if (!id) return undefined
  return { id, entry: sandboxDriverCatalog[id] }
}
