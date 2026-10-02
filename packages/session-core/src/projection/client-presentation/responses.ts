import type { AgentEventEnvelope, AgentRuntimeEvent, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import { boundKeyedMap } from "@claxedo/harness/translate"
import { withDir } from "../presentation-events"
import type { CompatContext } from "./context"
import type { ResponseMembers } from "./state"

const RETAINED_RESPONSES_MAX = 256

export const WITHDRAWN_TOOL = "Withdrawn: the model refused this response"

function currentMembers(ctx: CompatContext): ResponseMembers | undefined {
  const current = ctx.responses.current
  return current === undefined ? undefined : ctx.responses.members.get(current)
}

export function enterResponse(ctx: CompatContext, chunk: AgentRuntimeEventOf<"response-start">): AgentEventEnvelope[] {
  ctx.responses.current = chunk.responseId
  if (!ctx.responses.members.has(chunk.responseId)) ctx.responses.members.set(chunk.responseId, { parts: [], toolCallIds: [] })
  boundKeyedMap(ctx.responses.members, RETAINED_RESPONSES_MAX)
  ctx.splitText = true
  ctx.splitReasoning = true
  return []
}

export function recordResponseMembers(ctx: CompatContext, event: AgentRuntimeEvent, envelopes: AgentEventEnvelope[]): AgentEventEnvelope[] {
  const members = currentMembers(ctx)
  if (!members) return envelopes
  if (event.type === "tool-start" && !members.toolCallIds.includes(event.toolCallId)) members.toolCallIds.push(event.toolCallId)
  for (const { payload } of envelopes) {
    if (payload.type !== "message.part.updated") continue
    const part = payload.properties.part
    if (part.type !== "text" && part.type !== "reasoning") continue
    if (!members.parts.some((known) => known.partID === part.id)) members.parts.push({ messageID: part.messageID, partID: part.id })
  }
  return envelopes
}

export function retractResponses(
  ctx: CompatContext,
  chunk: AgentRuntimeEventOf<"response-retracted">,
  withdrawTools: (toolCallIds: ReadonlySet<string>) => AgentEventEnvelope[],
): AgentEventEnvelope[] {
  const withdrawn = chunk.responseIds.flatMap((id) => {
    const members = ctx.responses.members.get(id)
    ctx.responses.members.delete(id)
    if (ctx.responses.current === id) ctx.responses.current = undefined
    return members ? [members] : []
  })
  if (!withdrawn.length) return []
  ctx.splitText = true
  ctx.splitReasoning = true
  const parts = withdrawn.flatMap((members) => members.parts)
  return [
    ...(parts.length ? [withDir(ctx.directory, {
      id: `message.part.retracted:${ctx.sessionId}:${chunk.responseIds.join(",")}`,
      type: "message.part.retracted" as const,
      properties: { sessionID: ctx.sessionId, reason: chunk.reason, parts },
    })] : []),
    ...withdrawTools(new Set(withdrawn.flatMap((members) => members.toolCallIds))),
  ]
}
