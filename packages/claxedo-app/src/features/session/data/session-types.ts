import { assistantMessageIdForTurn } from "@claxedo/agent-event-runtime/contracts"
import { asRecord } from "@/lib/record"
import type { RuntimeSession, SessionTurnOutcome } from "@/platform/runtime/session"
export type { SessionTurnOutcome } from "@/platform/runtime/session"
export type ClaxedoSession = RuntimeSession

export function normalizeSessionTurnOutcome(input: unknown): SessionTurnOutcome | undefined {
  const row = asRecord(input)
  const completedAt = typeof row?.completedAt === "number" && Number.isFinite(row.completedAt)
    ? row.completedAt
    : undefined
  if (completedAt === undefined) return undefined
  if (row?.status === "completed") {
    const reason = typeof row.reason === "string" ? row.reason : undefined
    return { status: "completed", completedAt, ...(reason ? { reason } : {}), ...assistantMessageId(row) }
  }
  if (row?.status === "failed") {
    return {
      status: "failed",
      completedAt,
      error: typeof row.error === "string" ? row.error : "unknown",
      ...assistantMessageId(row),
    }
  }
  if (row?.status === "cancelled") {
    const reason = typeof row.reason === "string" ? row.reason : undefined
    return { status: "cancelled", completedAt, ...(reason ? { reason } : {}), ...assistantMessageId(row) }
  }
  return undefined
}

export function sessionTurnOutcomeSettled(outcome: SessionTurnOutcome | undefined) {
  return outcome?.status === "completed" || outcome?.status === "failed" || outcome?.status === "cancelled"
}

export function assistantMessageIdForUserMessage(messageId: string | undefined) {
  return messageId ? assistantMessageIdForTurn(messageId) : undefined
}

export function sessionTurnOutcomeMatchesAssistant(input: {
  outcome?: SessionTurnOutcome
  assistantMessageId?: string
}) {
  return sessionTurnOutcomeSettled(input.outcome) &&
    !!input.assistantMessageId &&
    input.outcome?.assistantMessageId === input.assistantMessageId
}

function assistantMessageId(row: Record<string, unknown>) {
  return typeof row.assistantMessageId === "string" ? { assistantMessageId: row.assistantMessageId } : {}
}
