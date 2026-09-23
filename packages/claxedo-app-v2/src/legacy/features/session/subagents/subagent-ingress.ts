import type { AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { SubagentRegistry } from "./subagent-registry"
import { sessionEventInfoId, sessionEventSummary } from "../data/sync/session-event-info"

type SessionLifecycleEvent = { type: string; properties: unknown }

export function applySubagentPresentationEvent(
  event: Extract<AgentPresentationEvent, { type: "subagent.updated" }>,
  registry: SubagentRegistry,
) {
  registry.apply(event.properties.sessionID, { type: "subagent-updated", ...event.properties.update })
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


