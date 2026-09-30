import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import { withoutKey, type ClaudeSdkAdapterState, type ClaudeTranslation } from "./adapter-state"
import { meteredResult, meterRequest } from "./request-usage"
import type { ClaudeSdkStreamEvent } from "./sdk-message"
import { claudeStreamOwner } from "./subagent-routing"

export type ClaudeSubagentUsage = {
  parent_tool_use_id: string | null
  session_id?: string
  message: { id: string; usage: Record<string, unknown>; model?: string }
}

export const CLAUDE_SUBAGENT_USAGE_METHOD = "claude/subagent-usage"

type MessageStart = Extract<ClaudeSdkStreamEvent, { type: "message_start" }>
type MessageDelta = Extract<ClaudeSdkStreamEvent, { type: "message_delta" }>

export function translateSubagentUsage(state: ClaudeSdkAdapterState, message: Record<string, unknown>): ClaudeTranslation {
  const request = asRecord(message.message)
  const requestId = text(request?.id)
  if (!requestId) return []
  return meteredResult(state, meterRequest(state, claudeStreamOwner(message), requestId, asRecord(request?.usage), text(message.session_id), text(request?.model)))
}

export function translateMessageStart(stream: MessageStart, message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  const owner = claudeStreamOwner(message)
  const requestId = text(stream.message.id)
  if (!requestId) return []
  const streaming = {
    ...state,
    streamingRequestByOwner: { ...state.streamingRequestByOwner, [owner]: requestId },
    ...(owner ? {} : { lastMainRequest: requestId }),
  }
  const metered = meterRequest(streaming, owner, requestId, asRecord(stream.message.usage), text(message.session_id), text(stream.message.model))
  return metered ? meteredResult(streaming, metered) : { state: streaming, events: [] }
}

export function translateMessageDelta(stream: MessageDelta, message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  const owner = claudeStreamOwner(message)
  const requestId = own(state.streamingRequestByOwner ?? {}, owner)
  if (!requestId) return []
  return meteredResult(state, meterRequest(state, owner, requestId, asRecord(stream.usage), text(message.session_id), undefined))
}

export function translateMessageStop(message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  return { state: { ...state, streamingRequestByOwner: withoutKey(state.streamingRequestByOwner ?? {}, claudeStreamOwner(message)) }, events: [] }
}
