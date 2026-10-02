import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { boundKeyedMap, own } from "../../../translate/value"
import type { ClaudeSdkAdapterState } from "./adapter-state"
import { diagnosticForEvent, type ClaudeFrameEvent } from "./sdk-message"
import type { ClaudeTranslatorMemory } from "./translator-memory"

const REMEMBERED_FRAMES = 4096
const REFUSAL = "refusal"

export function announceResponse(state: ClaudeSdkAdapterState, owner: string, responseId: string) {
  if (own(state.responseByOwner ?? {}, owner) === responseId) return { state, events: [] }
  const events: AgentRuntimeEvent[] = [{ type: "response-start", responseId }]
  return { state: { ...state, responseByOwner: { ...state.responseByOwner, [owner]: responseId } }, events }
}

export function rememberFrame(memory: ClaudeTranslatorMemory, frameId: string | undefined, responseId: string) {
  if (!frameId) return
  memory.responseByFrame.set(frameId, responseId)
  boundKeyedMap(memory.responseByFrame, REMEMBERED_FRAMES)
}

export function noteRefusal(memory: ClaudeTranslatorMemory, responseId: string | undefined, stopReason: unknown) {
  if (responseId && stopReason === REFUSAL) memory.refusedResponses.add(responseId)
}

function framedResponses(memory: ClaudeTranslatorMemory, frameIds: readonly unknown[]) {
  return [...new Set(frameIds.flatMap((id) => (typeof id === "string" ? memory.responseByFrame.get(id) ?? [] : [])))]
}

function retraction(memory: ClaudeTranslatorMemory, responseIds: string[]): AgentRuntimeEvent[] {
  for (const id of responseIds) memory.refusedResponses.delete(id)
  return responseIds.length ? [{ type: "response-retracted", responseIds, reason: REFUSAL }] : []
}

export function supersededResponses(memory: ClaudeTranslatorMemory, frameIds: unknown): AgentRuntimeEvent[] {
  return Array.isArray(frameIds) ? retraction(memory, framedResponses(memory, frameIds)) : []
}

export function refusalRetraction(memory: ClaudeTranslatorMemory, frameIds: unknown, event: ClaudeFrameEvent): AgentRuntimeEvent[] {
  const named = framedResponses(memory, Array.isArray(frameIds) ? frameIds : [])
  if (named.length) return retraction(memory, named)
  const refused = [...memory.refusedResponses]
  return [
    diagnosticForEvent({ code: "claude_sdk.retraction_unmapped", severity: "warn", event,
      message: refused.length
        ? "Claude retracted messages this transport never saw; withdrawing the responses whose stream stopped on the refusal"
        : "Claude retracted messages this transport never saw, and no response stopped on a refusal; nothing is withdrawn",
      details: { retractedMessageUuids: Array.isArray(frameIds) ? frameIds.length : 0, refusedResponses: refused.length } }),
    ...retraction(memory, refused),
  ]
}
