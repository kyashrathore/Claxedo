import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { SubagentRegistry } from "./subagent-registry"
import { sessionEventInfoId, sessionEventSummary } from "../data/sync/session-event-info"

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
    const sessionId = sessionEventInfoId(payload.properties)
    if (sessionId) registry.deleteParent(sessionId)
    return !!sessionId
  }
  if (payload.type !== "session.updated") return false
  const info = sessionEventSummary(payload.properties)
  if (!info || info.archived === undefined) return false
  registry.archiveParent(info.id)
  return true
}

export function abortSubagentsForParent(parentSessionId: string, registry: SubagentRegistry) {
  return registry.abortParent(parentSessionId, (entry) =>
    Math.max(0, ...Object.values(entry.fieldRevisions)) + 1
  )
}


