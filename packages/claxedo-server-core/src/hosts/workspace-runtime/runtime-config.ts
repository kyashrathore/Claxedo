import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { getRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "../../agent-config"

type ClaxedoRuntimeConfigInput = {
  workspaceDir?: string
  workspaceId?: string
  secretScope?: "local" | "shared"
}

export async function createClaxedoRuntimeConfig(input: ClaxedoRuntimeConfigInput = {}): Promise<RuntimeConfigSnapshot> {
  return getRuntimeConfigSnapshot(undefined, input)
}

export async function createClaxedoAppliedRuntimeConfig(input: ClaxedoRuntimeConfigInput = {}) {
  const snapshot = normalizeRuntimeSnapshot(await createClaxedoRuntimeConfig(input))
  if (!snapshot) throw new Error("invalid Claxedo workspace runtime snapshot")
  return snapshot
}
