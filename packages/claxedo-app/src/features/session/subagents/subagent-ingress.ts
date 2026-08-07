import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { SubagentRegistry } from "./subagent-registry"

type SessionLifecycleEvent = { type: string; properties: unknown }

export function applySubagentRuntimeEventEnvelope(
  input: { sessionId: string; payload: AgentRuntimeEvent },
  registry: SubagentRegistry,
) {
  if (input.payload.type !== "subagent-updated") return false
  registry.apply(input.sessionId, input.payload)
  return true
}

export function applySubagentCompatLifecycleEvent(
  payload: SessionLifecycleEvent,
  registry: SubagentRegistry,
) {
  if (payload.type === "session.deleted") {
    const sessionId = objectId((payload.properties as { info?: unknown }).info)
    if (sessionId) registry.deleteParent(sessionId)
    return !!sessionId
  }
  if (payload.type !== "session.updated") return false
  const info = record((payload.properties as { info?: unknown }).info)
  const sessionId = objectId(info)
  if (!sessionId || typeof record(info?.time)?.archived !== "number") return false
  registry.archiveParent(sessionId)
  return true
}

export function abortSubagentsForParent(parentSessionId: string, registry: SubagentRegistry) {
  return registry.abortParent(parentSessionId, (entry) =>
    Math.max(0, ...Object.values(entry.fieldRevisions)) + 1
  )
}

function objectId(input: unknown) {
  const value = record(input)?.id
  return typeof value === "string" ? value : undefined
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}
