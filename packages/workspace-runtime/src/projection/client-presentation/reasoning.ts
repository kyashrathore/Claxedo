import type { AgentEventEnvelope, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { partEvent, type CompatContext } from "./context"

export const REASONING_ENDS_ON = new Set<AgentRuntimeEvent["type"]>([
  "text-delta",
  "proposed-plan-delta",
  "proposed-plan-complete",
  "tool-start",
  "file-diff",
  "image-delta",
  "audio-delta",
  "resource-link-delta",
  "permission-request",
  "question",
  "step-start",
  "response-start",
  "finish",
  "cancelled",
  "error",
])

export function endReasoning(ctx: CompatContext, now: () => number): AgentEventEnvelope[] {
  const open = ctx.openReasoning
  if (!open) return []
  ctx.openReasoning = undefined
  ctx.splitReasoning = true
  const end = now()
  return [partEvent(ctx.directory, {
    id: open.partId,
    sessionID: ctx.sessionId,
    messageID: open.messageId,
    type: "reasoning",
    text: open.text,
    time: { start: open.start, end },
  }, end)]
}
