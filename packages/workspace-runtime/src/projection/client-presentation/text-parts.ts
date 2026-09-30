import type { AgentContentPart, AgentEventEnvelope, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { messagePartDelta, messageUpdated, withDir } from "../presentation-events"
import { partEvent, seen, seqId, type CompatContext } from "./context"

/**
 * The turn's PROMPT: its row, and the text arriving on it.
 *
 * A viewer attached to someone else's turn has this lane and nothing else, and
 * a turn is two messages — the reply hangs off the prompt, so a consumer that
 * never receives the prompt row has nowhere to put the reply. The lane names
 * the prompt on every `user-message-delta`, so the first chunk opens the row
 * and each chunk extends its text, exactly as the reply's own parts are built.
 *
 * Only what the lane carries is written: no model, and the agent it last
 * reported. The session's settled transcript stays authoritative for the rest.
 */
export function userMessageText(
  ctx: CompatContext,
  messageId: string,
  delta: string,
  now: () => number,
): AgentEventEnvelope[] {
  const events: AgentEventEnvelope[] = []
  const eventTime = now()
  if (ctx.announcedUserMsgId !== messageId) {
    ctx.announcedUserMsgId = messageId
    events.push(withDir(ctx.directory, messageUpdated({
      id: messageId,
      sessionID: ctx.sessionId,
      role: "user",
      time: { created: eventTime },
      agent: ctx.agentId,
      model: { providerID: "", modelID: "" },
    })))
  }
  const key = `${messageId}-text`
  const fresh = !seen(ctx, key)
  const id = seqId(ctx, key)
  if (fresh) {
    events.push(partEvent(ctx.directory, {
      id,
      sessionID: ctx.sessionId,
      messageID: messageId,
      type: "text",
      text: "",
    }, eventTime))
  }
  events.push(withDir(ctx.directory, messagePartDelta({
    sessionID: ctx.sessionId,
    messageID: messageId,
    partID: id,
    field: "text",
    delta,
  })))
  return events
}

export function deltaText(
  ctx: CompatContext,
  type: "text" | "reasoning",
  delta: string,
  now: () => number,
): AgentEventEnvelope[] {
  const seqKey = type === "text" ? "textPartSeq" : "reasoningPartSeq"
  const splitKey = type === "text" ? "splitText" : "splitReasoning"
  const partKey = () => `${ctx.assistantMsgId}-${type}${ctx[seqKey] > 0 ? `-${ctx[seqKey]}` : ""}`
  if (ctx[splitKey] && seen(ctx, partKey())) {
    ctx[seqKey] += 1
  }
  ctx[splitKey] = false
  const key = partKey()
  const fresh = !seen(ctx, key)
  const id = seqId(ctx, key)
  const eventTime = now()
  const base: AgentContentPart =
    type === "text"
      ? {
          id,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "text",
          text: fresh ? "" : ctx.accumulatedText,
        }
      : {
          id,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "reasoning",
          text: fresh ? "" : ctx.accumulatedThinkingText,
          time: { start: eventTime },
        }
  const events = fresh ? [partEvent(ctx.directory, base, eventTime)] : []
  events.push(
    withDir(
      ctx.directory,
      messagePartDelta({
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        partID: id,
        field: "text",
        delta,
      }),
    ),
  )
  if (type === "text") {
    ctx.accumulatedText += delta
    return events
  }
  ctx.accumulatedThinkingText += delta
  const open = ctx.openReasoning?.partId === id ? ctx.openReasoning : undefined
  ctx.openReasoning = open
    ? { ...open, text: open.text + delta }
    : { partId: id, messageId: ctx.assistantMsgId, start: eventTime, text: delta }
  return events
}

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
