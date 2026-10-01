import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { ContentBlock, SessionUpdate } from "./types"
import { RETAINED_MESSAGE_TEXTS_MAX, type SessionState, type TranslatorContext } from "./state"
import { checkContentBlock } from "./validation"
import { diagnoseTranslation, shape } from "./diagnostics"
import { boundKeyedMap } from "../../../translate/value"

type AgentChunk = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>

function acpTextChunkDelta(content: string, update: AgentChunk, state: SessionState): string {
  const thinking = update.sessionUpdate === "agent_thought_chunk"
  const key = update.messageId ?? (thinking ? "__thinking" : "__assistant")
  const seen = thinking ? state.assistantThinkingByMessageId : state.assistantTextByMessageId
  const previous = seen.get(key) ?? ""
  const cumulative = content.startsWith(previous)
  seen.set(key, cumulative ? content : `${previous}${content}`)
  boundKeyedMap(seen, RETAINED_MESSAGE_TEXTS_MAX)
  return cumulative ? content.slice(previous.length) : content
}

function agentContentEvents(content: ContentBlock, update: AgentChunk, state: SessionState): AgentRuntimeEvent[] {
  const thinking = update.sessionUpdate === "agent_thought_chunk"
  switch (content.type) {
    case "text": {
      const delta = acpTextChunkDelta(content.text, update, state)
      return delta ? [{ type: thinking ? "thinking-delta" : "text-delta", delta }] : []
    }
    case "image":
      return thinking
        ? [{ type: "resource-delta", resource: content, channel: "thinking" }]
        : [{ type: "image-delta", mimeType: content.mimeType, data: content.data }]
    case "audio":
      return [
        { type: thinking ? "thinking-audio-delta" : "audio-delta", mimeType: content.mimeType, data: content.data },
      ]
    case "resource_link":
      return [
        {
          type: thinking ? "thinking-resource-link-delta" : "resource-link-delta",
          uri: content.uri,
          name: content.name,
          mimeType: content.mimeType ?? undefined,
          title: content.title ?? undefined,
        },
      ]
    case "resource": {
      const resource = content.resource
      return "text" in resource && typeof resource.text === "string"
        ? [{ type: thinking ? "thinking-delta" : "text-delta", delta: resource.text }]
        : [{ type: "resource-delta", resource, channel: thinking ? "thinking" : "assistant" }]
    }
  }
}

export function agentMessage(update: AgentChunk, ctx: TranslatorContext): AgentRuntimeEvent[] {
  const kind = update.sessionUpdate
  const check = checkContentBlock(update.content)
  if (!check.ok && check.reason !== "unknown_content_block") {
    diagnoseTranslation(ctx.diagnostics, "acp.malformed_content", {
      kind,
      reason: check.reason,
      shape: shape(update.content),
    })
    return []
  }
  const events: AgentRuntimeEvent[] = []
  const messageId = update.messageId
  if (kind === "agent_message_chunk" && messageId != null && messageId !== ctx.state.lastMessageId) {
    events.push({ type: "step-start", newMessageId: messageId })
    ctx.state.lastMessageId = messageId
  }
  const translated = check.ok ? agentContentEvents(check.block, update, ctx.state) : []
  if (translated.length) events.push(...translated)
  else
    diagnoseTranslation(ctx.diagnostics, "acp.unknown_content_type", {
      kind,
      shape: shape(update.content),
      reason: "unknown_content_block",
    })
  return events
}
