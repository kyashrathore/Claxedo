import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { getRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "../../agent-config"
import type { AgentExtensionPolicyOverride } from "../agent-extensions/runtime-config"
import type { WorkspaceAgentExtensionRecord } from "../agent-extensions/workspace"

type ClaxedoRuntimeConfigInput = {
  workspaceDir?: string
  workspaceId?: string
  secretScope?: "local" | "shared"
  workspaceInstalls?: WorkspaceAgentExtensionRecord[]
  policyOverrides?: AgentExtensionPolicyOverride[]
}

export async function createClaxedoRuntimeConfig(input: ClaxedoRuntimeConfigInput = {}): Promise<RuntimeConfigSnapshot> {
  return getRuntimeConfigSnapshot(undefined, input)
}

export async function createClaxedoAppliedRuntimeConfig(input: ClaxedoRuntimeConfigInput = {}) {
  const snapshot = normalizeRuntimeSnapshot(await createClaxedoRuntimeConfig(input))
  if (!snapshot) throw new Error("invalid Claxedo workspace runtime snapshot")
  return snapshot
}
