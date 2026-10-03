import type { AgentEventEnvelope, AgentRuntimeEventOf, TranscriptNotice } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import { runtimeDiagnostic, sessionCompacted, withDir } from "../presentation-events"
import { partEvent, seqId, type CompatContext } from "./context"

type HarnessNotice = AgentRuntimeEventOf<"harness-notice">
type Compaction = AgentRuntimeEventOf<"session-compaction">

function nextNoticePartId(ctx: CompatContext): string {
  ctx.notices.noticeCount += 1
  return seqId(ctx, `${ctx.assistantMsgId}-notice-${ctx.notices.noticeCount}`)
}

function noticePart(ctx: CompatContext, id: string, notice: TranscriptNotice, now: number): AgentEventEnvelope {
  ctx.splitText = true
  ctx.splitReasoning = true
  return partEvent(ctx.directory, { id, sessionID: ctx.sessionId, messageID: ctx.assistantMsgId, type: "notice", notice, time: { created: now } }, now)
}

export const eventNoticePartId = (sessionId: string, eventId: string) => `${sessionId}-notice-${eventId}`

export function appendNotice(ctx: CompatContext, notice: TranscriptNotice, now: number, eventId?: string): AgentEventEnvelope {
  return noticePart(ctx, eventId ? eventNoticePartId(ctx.sessionId, eventId) : nextNoticePartId(ctx), notice, now)
}

function noticeDiagnostic(ctx: CompatContext, chunk: HarnessNotice): AgentEventEnvelope {
  return withDir(ctx.directory, runtimeDiagnostic({
    sessionID: ctx.sessionId,
    harness: chunk.harness,
    threadId: chunk.threadId,
    code: chunk.code,
    message: chunk.message,
    severity: chunk.severity ?? "info",
    details: chunk.details,
    raw: chunk.raw,
  }))
}

function projectConversationReset(ctx: CompatContext, chunk: AgentRuntimeEventOf<"conversation-reset">, now: () => number): AgentEventEnvelope[] {
  return ctx.assistantMsgId ? [appendNotice(ctx, { kind: "conversation-reset", trigger: chunk.trigger }, now())] : []
}

function projectHarnessNotice(ctx: CompatContext, chunk: HarnessNotice, now: () => number): AgentEventEnvelope[] {
  const severity = chunk.severity ?? "info"
  if (severity === "debug" || !ctx.assistantMsgId) return [noticeDiagnostic(ctx, chunk)]
  return [appendNotice(ctx, { kind: "harness", code: chunk.code, message: chunk.message, severity }, now(), chunk.eventId)]
}

function compactionOutcome(chunk: Compaction): TranscriptNotice {
  if (chunk.metadata?.aborted === true) return { kind: "compaction", status: "failed", error: "Compaction was stopped" }
  const error = chunk.metadata?.error
  if (error) return { kind: "compaction", status: "failed", error: errorMessage(error) }
  return { kind: "compaction", status: "completed" }
}

function projectCompaction(ctx: CompatContext, chunk: Compaction, now: () => number): AgentEventEnvelope[] {
  if (!ctx.assistantMsgId) return []
  if (chunk.phase === "started") {
    const id = nextNoticePartId(ctx)
    ctx.notices.runningCompactionPartId = id
    return [noticePart(ctx, id, { kind: "compaction", status: "running" }, now())]
  }
  const id = ctx.notices.runningCompactionPartId ?? nextNoticePartId(ctx)
  ctx.notices.runningCompactionPartId = undefined
  const outcome = compactionOutcome(chunk)
  const part = noticePart(ctx, id, outcome, now())
  return outcome.kind === "compaction" && outcome.status === "completed" ? [part, withDir(ctx.directory, sessionCompacted(ctx.sessionId))] : [part]
}

export function projectNotice(ctx: CompatContext, chunk: AgentRuntimeEventOf<"session-compaction" | "harness-notice" | "agent-message" | "conversation-reset">, now: () => number) {
  switch (chunk.type) {
    case "session-compaction":
      return projectCompaction(ctx, chunk, now)
    case "harness-notice":
      return projectHarnessNotice(ctx, chunk, now)
    case "agent-message":
      return ctx.assistantMsgId ? [appendNotice(ctx, { kind: "agent-message", sender: chunk.sender, message: chunk.message,
        ...(chunk.senderName ? { senderName: chunk.senderName } : {}),
        ...(chunk.senderTaskId ? { senderTaskId: chunk.senderTaskId } : {}),
        ...(chunk.sourceSessionId ? { sourceSessionId: chunk.sourceSessionId } : {}) }, now(), chunk.eventId)] : []
  }
  return projectConversationReset(ctx, chunk, now)
}
