import { asText } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { diagnosticForEvent, type ClaudeFrameEvent } from "./sdk-message"

export function claudeAgentMessage(frame: Record<string, unknown>, event: ClaudeFrameEvent): AgentRuntimeEvent[] | undefined {
  const origin = asRecord(frame.origin)
  if (frame.type !== "user" || frame.parent_tool_use_id || origin?.kind !== "peer") return undefined
  const eventId = asText(frame.uuid)
  const sender = asText(origin.from)
  const message = typeof origin.body === "string" ? origin.body : undefined
  if (!eventId || !sender || message === undefined) {
    return [diagnosticForEvent({ code: "claude_sdk.peer_message_incomplete", severity: "warn", event,
      message: "Claude supplied a peer message without its identity, sender, or decoded body" })]
  }
  const senderTaskId = asText(origin.senderTaskId)
  const sourceSessionId = asText(origin.fromSession)
  const senderName = asText(origin.name)
  return [{ type: "agent-message", eventId, sender, message,
    ...(senderName ? { senderName } : {}),
    ...(senderTaskId ? { senderTaskId } : {}), ...(sourceSessionId ? { sourceSessionId } : {}) }]
}

export function isClaudeOutsideTurnNotice(frame: unknown): boolean {
  const message = asRecord(frame)
  return (message?.type === "system" && message.subtype === "task_notification")
    || (message?.type === "user" && !message.parent_tool_use_id && asRecord(message.origin)?.kind === "peer")
}
