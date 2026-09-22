import { asRecord } from "@claxedo/agent-runtime-contract"
import type { SubagentObservation } from "../../subagent-admission"

/** ACP draft #1992, implemented by claude-agent-acp and codex-acp.
 * https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-subagents.ts
 * Keep the versioned provider extension at the wire boundary until the SDK ships it.
 */
export const ACP_SUBAGENT_CLIENT_CAPABILITIES = {
  subagents: {},
  _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } },
} as const

export function supportsACPSubagents(initialize: unknown): boolean {
  const response = asRecord(initialize)
  const caps = asRecord(asRecord(response?.agentCapabilities)?.sessionCapabilities)
  if (asRecord(caps?.subagents)) return true
  const air = asRecord(asRecord(asRecord(response?._meta)?.jetbrains)?.air)
  return typeof air?.version === "number" && Number.isInteger(air.version) && air.version >= 1
    && Array.isArray(air.capabilities) && air.capabilities.includes("nativeSubagentSessions")
}

export type ACPSubagentUpdate = {
  agentSessionId: string
  observation: SubagentObservation
  capabilities?: { cancel: boolean; close: boolean }
}

/** Only explicit provider lineage creates a child. Tool names and tool metadata
 * never imply a child session. The caller must negotiate support before parsing.
 */
/** Provider state names, and the observation status each one reports. */
const ACP_SUBAGENT_STATUS = new Map<string, NonNullable<SubagentObservation["status"]>>([
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "killed"],
  ["disconnected", "interrupted"],
])

export function acpSubagentUpdate(update: unknown): ACPSubagentUpdate | undefined {
  const row = asRecord(update)
  if (!row || typeof row.subagentSessionId !== "string" || !row.subagentSessionId.trim()) return undefined
  const agentSessionId = row.subagentSessionId
  const identity = {
    providerId: agentSessionId,
    providerKind: "acp",
    stableCorrelationId: agentSessionId,
    transcript: { kind: "messages" as const },
  }
  if (row.sessionUpdate === "subagent_spawned") {
    if (typeof row.name !== "string" || typeof row.task !== "string" || !asRecord(row.capabilities)) return undefined
    const capabilities = asRecord(row.capabilities)!
    if (capabilities.cancel !== undefined && typeof capabilities.cancel !== "boolean") return undefined
    if (capabilities.close !== undefined && typeof capabilities.close !== "boolean") return undefined
    return {
      agentSessionId,
      capabilities: { cancel: capabilities.cancel === true, close: capabilities.close === true },
      observation: {
        ...identity,
        observationId: `acp:subagent:${agentSessionId}:spawned`,
        status: "running",
        label: row.name,
        description: row.task,
      },
    }
  }
  if (row.sessionUpdate !== "subagent_state_update") return undefined
  const state = typeof row.state === "string" ? row.state : ""
  const status = ACP_SUBAGENT_STATUS.get(state)
  if (!status) return undefined
  return {
    agentSessionId,
    observation: { ...identity, observationId: `acp:subagent:${agentSessionId}:${state}`, status },
  }
}

export type ACPSubagentNotification = { sessionId: string; update: Record<string, unknown> }

/** Admit only negotiated provider lineage before the SDK's stable update parser. */
export async function receiveACPSubagentNotification(message: unknown, host: {
  enabled: boolean
  parents: Map<string, string>
  rootSessionId: (sessionId: string) => string
  touch: (sessionId: string) => void
  listeners: Map<string, (notification: ACPSubagentNotification) => Promise<void>>
  diagnose: (message: string, detail: Record<string, unknown>) => void
}): Promise<boolean> {
    const frame = asRecord(message)
    if (frame?.method !== "session/update" || "id" in frame) return false
    const params = asRecord(frame.params)
    const update = asRecord(params?.update)
    if (typeof params?.sessionId !== "string" || !update) return false
    const lifecycle = update.sessionUpdate === "subagent_spawned" || update.sessionUpdate === "subagent_state_update"
    if (!lifecycle && !host.parents.has(params.sessionId)) return false
    // Unnegotiated/malformed draft frames must not reach the SDK's closed union.
    if (!host.enabled) return lifecycle
    const parsed = lifecycle ? acpSubagentUpdate(update) : undefined
    if (lifecycle && !parsed) {
      host.diagnose("Malformed ACP subagent lifecycle notification", { sessionId: params.sessionId })
      return true
    }
    if (parsed && !parsed.capabilities && host.parents.get(parsed.agentSessionId) !== params.sessionId) {
      host.diagnose("ACP child state update has no matching parent identity", { sessionId: params.sessionId, child: parsed.agentSessionId })
      return true
    }
    if (parsed?.capabilities) {
      const oldParent = host.parents.get(parsed.agentSessionId)
      if (parsed.agentSessionId === params.sessionId || parsed.agentSessionId === host.rootSessionId(params.sessionId) || (oldParent && oldParent !== params.sessionId)) {
        host.diagnose("Conflicting ACP subagent parent identity", { sessionId: params.sessionId, child: parsed.agentSessionId })
        return true
      }
      host.parents.set(parsed.agentSessionId, params.sessionId)
    }
    const root = host.rootSessionId(params.sessionId)
    host.touch(root)
    const listener = host.listeners.get(root)
    if (!listener) {
      host.diagnose("ACP subagent update has no active owner", { sessionId: params.sessionId })
      return true
    }
    await listener({ sessionId: params.sessionId, update })
    return true
}

export function acpRootSessionId(parents: Map<string, string>, sessionId: string): string {
  const seen = new Set<string>()
  while (parents.has(sessionId) && !seen.has(sessionId)) {
    seen.add(sessionId)
    sessionId = parents.get(sessionId)!
  }
  return sessionId
}
