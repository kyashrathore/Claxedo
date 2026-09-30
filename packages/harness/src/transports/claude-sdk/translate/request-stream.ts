import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import { withoutKey, type ClaudeSdkAdapterState, type ClaudeTranslation } from "./adapter-state"
import { latestMainRequest, meteredResult, meterRequest } from "./request-usage"
import type { ClaudeSdkStreamEvent } from "./sdk-message"
import { claudeStreamOwner } from "./subagent-routing"
import type { ClaudeTranslatorMemory } from "./translator-memory"

export type ClaudeSubagentUsage = {
  parent_tool_use_id: null
  subpath: string
  session_id?: string
  message: { id: string; usage: Record<string, unknown>; model?: string }
}

export const CLAUDE_SUBAGENT_USAGE_METHOD = "claude/subagent-usage"

type MessageStart = Extract<ClaudeSdkStreamEvent, { type: "message_start" }>
type MessageDelta = Extract<ClaudeSdkStreamEvent, { type: "message_delta" }>

export function translateSubagentUsage(state: ClaudeSdkAdapterState, memory: ClaudeTranslatorMemory, message: Record<string, unknown>): ClaudeTranslation {
  const request = asRecord(message.message)
  const requestId = text(request?.id)
  const transcript = text(message.subpath)
  if (!requestId || !transcript) return []
  const claimed = memory.owners.get(requestId)
  if (claimed !== undefined && claimed !== transcript) return []
  return meteredResult(meterRequest(state, memory, transcript, requestId, asRecord(request?.usage), text(message.session_id), text(request?.model),
    { context: latestMainRequest(state) }))
}

export function translateMessageStart(stream: MessageStart, message: Record<string, unknown>, state: ClaudeSdkAdapterState,
  memory: ClaudeTranslatorMemory): ClaudeTranslation {
  const owner = claudeStreamOwner(message)
  const requestId = text(stream.message.id)
  if (!requestId) return []
  const streaming = {
    ...state,
    streamingRequestByOwner: { ...state.streamingRequestByOwner, [owner]: requestId },
    ...(owner ? {} : { lastMainRequest: requestId }),
  }
  const metered = meterRequest(streaming, memory, owner, requestId, asRecord(stream.message.usage), text(message.session_id), text(stream.message.model))
  return metered ? meteredResult(metered) : { state: streaming, events: [] }
}

export function translateMessageDelta(stream: MessageDelta, message: Record<string, unknown>, state: ClaudeSdkAdapterState,
  memory: ClaudeTranslatorMemory): ClaudeTranslation {
  const owner = claudeStreamOwner(message)
  const requestId = own(state.streamingRequestByOwner ?? {}, owner)
  if (!requestId) return []
  return meteredResult(meterRequest(state, memory, owner, requestId, asRecord(stream.usage), text(message.session_id), undefined))
}

export function translateMessageStop(message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  return { state: { ...state, streamingRequestByOwner: withoutKey(state.streamingRequestByOwner ?? {}, claudeStreamOwner(message)) }, events: [] }
}
