import type { Session } from "@opencode-ai/sdk/v2/client"

export type SessionTurnOutcome = (
  | { status: "completed"; completedAt: number; reason?: string }
  | { status: "failed"; completedAt: number; error: string }
  | { status: "cancelled"; completedAt: number; reason?: string }
) & { assistantMessageId?: string }

export type ClaxedoSession = Session & {
  status?: string | null
  recovery_error?: string | null
  lastTurn?: SessionTurnOutcome
}

export function normalizeSessionTurnOutcome(input: unknown): SessionTurnOutcome | undefined {
  const row = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
  const completedAt = typeof row?.completedAt === "number" && Number.isFinite(row.completedAt)
    ? row.completedAt
    : undefined
  if (completedAt === undefined) return
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
}

export function sessionTurnOutcomeSettled(outcome: SessionTurnOutcome | undefined) {
  return outcome?.status === "completed" || outcome?.status === "failed" || outcome?.status === "cancelled"
}

export function assistantMessageIdForUserMessage(messageId: string | undefined) {
  return messageId ? `${messageId}_r` : undefined
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
