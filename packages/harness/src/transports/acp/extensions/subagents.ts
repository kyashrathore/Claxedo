import type { InitializeResponse } from "@agentclientprotocol/sdk"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"

export function supportsAcpSubagents(handshake: InitializeResponse): boolean {
  const air = asRecord(asRecord(handshake._meta?.jetbrains)?.air)
  return air?.version === 1 && Array.isArray(air.capabilities) && air.capabilities.includes("nativeSubagentSessions")
}

export function acpSubagentObservation(update: unknown): { key: string; observation: SubagentObservation } | undefined {
  const row = asRecord(update)
  if (typeof row?.subagentSessionId !== "string") return undefined
  const key = row.subagentSessionId
  const identity = { providerId: key, providerKind: "acp", stableCorrelationId: key,
    mode: "background" as const, transcript: { kind: "messages" as const } }
  if (row.sessionUpdate === "subagent_spawned" && typeof row.name === "string" && typeof row.task === "string") {
    return { key, observation: { ...identity, observationId: `acp:subagent:${key}:spawned`, status: "running",
      label: row.name, description: row.task } }
  }
  if (row.sessionUpdate !== "subagent_state_update") return undefined
  const status = subagentStatus(row.state)
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
