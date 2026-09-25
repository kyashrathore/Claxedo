import type { InitializeResponse } from "@agentclientprotocol/sdk"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"

export function supportsAcpSubagents(handshake: InitializeResponse): boolean {
  const jetbrains = handshake._meta?.jetbrains
  if (!jetbrains || typeof jetbrains !== "object" || !("air" in jetbrains)) return false
  const air = jetbrains.air
  if (!air || typeof air !== "object" || !("version" in air) || air.version !== 1 || !("capabilities" in air)) return false
  return Array.isArray(air.capabilities) && air.capabilities.includes("nativeSubagentSessions")
}

export function acpSubagentObservation(update: unknown): { key: string; observation: SubagentObservation } | undefined {
  if (!update || typeof update !== "object" || !("sessionUpdate" in update) || !("subagentSessionId" in update) ||
    typeof update.subagentSessionId !== "string") return undefined
  const key = update.subagentSessionId
  const identity = { providerId: key, providerKind: "acp", stableCorrelationId: key,
    transcript: { kind: "messages" as const } }
  if (update.sessionUpdate === "subagent_spawned" && "name" in update && "task" in update &&
    typeof update.name === "string" && typeof update.task === "string") {
    return { key, observation: { ...identity, observationId: `acp:subagent:${key}:spawned`, status: "running",
      label: update.name, description: update.task } }
  }
  if (update.sessionUpdate !== "subagent_state_update" || !("state" in update)) return undefined
  const status = subagentStatus(update.state)
  if (!status) return undefined
  return { key, observation: { ...identity, observationId: `acp:subagent:${key}:${status}`, status } }
}

function subagentStatus(state: unknown): SubagentObservation["status"] | undefined {
  switch (state) {
    case "completed": return "completed"
    case "failed": return "failed"
    case "cancelled": return "killed"
    case "disconnected": return "interrupted"
    default: return undefined
  }
}
