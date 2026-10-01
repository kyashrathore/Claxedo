import type { AgentEventEnvelope, AgentRuntimeEvent, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import { sessionStatus, withDir } from "../presentation-events"
import type { CompatContext } from "./context"

const RESUMES_REPLY = new Set<AgentRuntimeEvent["type"]>([
  "text-delta",
  "thinking-delta",
  "proposed-plan-delta",
  "tool-start",
  "file-diff",
  "image-delta",
  "audio-delta",
  "resource-link-delta",
  "resource-delta",
  "step-start",
])

const SETTLES_STATUS = new Set<AgentRuntimeEvent["type"]>(["session-status", "finish", "cancelled", "error"])

export function projectRetry(ctx: CompatContext, chunk: AgentRuntimeEventOf<"session-retry">, now: () => number): AgentEventEnvelope[] {
  ctx.notices.retrying = true
  return [withDir(ctx.directory, sessionStatus(ctx.sessionId, {
    type: "retry",
    message: chunk.message,
    ...(chunk.attempt !== undefined ? { attempt: chunk.attempt } : {}),
    ...(chunk.delayMs !== undefined ? { next: now() + chunk.delayMs } : {}),
  }))]
}

export function resumeAfterRetry(ctx: CompatContext, event: AgentRuntimeEvent): AgentEventEnvelope[] {
  if (!ctx.notices.retrying) return []
  if (SETTLES_STATUS.has(event.type)) ctx.notices.retrying = false
  if (!RESUMES_REPLY.has(event.type)) return []
  ctx.notices.retrying = false
  return [withDir(ctx.directory, sessionStatus(ctx.sessionId, { type: "busy" }))]
}
