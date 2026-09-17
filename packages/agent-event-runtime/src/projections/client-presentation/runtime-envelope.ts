import type { AgentEventEnvelope, AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "../../contracts/agent-runtime-event"

/**
 * The runtime-channel events a client renders that the turn projection does
 * not emit: a subagent row revision and a goal change. Everything else on
 * that channel is either already projected by the turn (parts, tool state,
 * diagnostics) or is for in-process consumers only, so nothing else crosses
 * the wire from it.
 */
export function presentationEventsFromRuntimeEnvelope(input: {
  directory: string
  sessionId: string
  payload: AgentRuntimeEvent
}): AgentEventEnvelope[] {
  const payload = input.payload
  const withDirectory = (event: AgentPresentationEvent): AgentEventEnvelope => ({ directory: input.directory, payload: event })
  if (payload.type === "subagent-updated") {
    const { type: _type, ...update } = payload
    return [withDirectory({
      id: `subagent.updated:${input.sessionId}:${update.subagentKey}:${update.revision}`,
      type: "subagent.updated",
      properties: { sessionID: input.sessionId, update },
    })]
  }
  if (payload.type === "goal-updated") {
    return [withDirectory({
      id: `goal.updated:${payload.sessionId}:${payload.goal.updatedAt}`,
      type: "goal.updated",
      properties: { sessionID: payload.sessionId, goal: payload.goal },
    })]
  }
  if (payload.type === "goal-cleared") {
    return [withDirectory({
      id: `goal.cleared:${payload.sessionId}`,
      type: "goal.cleared",
      properties: { sessionID: payload.sessionId },
    })]
  }
  return []
}
