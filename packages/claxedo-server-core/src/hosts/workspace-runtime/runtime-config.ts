import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { getRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "../../agent-config"
import type { SandboxSecretBrokering } from "../../credentials/native-delivery"

type ClaxedoRuntimeConfigInput = {
  workspaceDir?: string
  workspaceId?: string
  secretScope?: "local" | "shared"
  orgId?: string
  secretBrokering?: SandboxSecretBrokering
}

export async function createClaxedoRuntimeConfig(input: ClaxedoRuntimeConfigInput = {}): Promise<RuntimeConfigSnapshot> {
  return getRuntimeConfigSnapshot(undefined, input)
}

/**
 * The snapshot already resolved against THIS process's environment, for a
 * runtime embedded in it.
 *
 * Shared scope is refused rather than resolved: a shared-scope projection names
 * variables the sandbox's own provider fills, and resolving those here would
 * mark every one of them missing from the server's environment.
 */
export async function createClaxedoAppliedRuntimeConfig(input: ClaxedoRuntimeConfigInput = {}) {
  if (input.secretScope === "shared") {
    throw new Error("a shared-scope runtime config resolves inside its own sandbox, not in this process")
  }
  const snapshot = normalizeRuntimeSnapshot(await createClaxedoRuntimeConfig(input))
  if (!snapshot) throw new Error("invalid Claxedo workspace runtime snapshot")
  return snapshot
}
