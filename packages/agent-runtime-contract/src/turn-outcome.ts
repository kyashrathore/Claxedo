import { asRecord } from "@claxedo/helpers/guards"
import type { AgentTurnOutcome } from "./sessions"
import { turnAccount } from "./turn-account"
import { FIRST_TURN_ERROR_CLASSES } from "./turn-error-classes"

export function parseAgentTurnOutcome(input: unknown): AgentTurnOutcome | undefined {
  if (input === undefined) return undefined
  const row = asRecord(input)
  if (!row || typeof row.completedAt !== "number" || !Number.isSafeInteger(row.completedAt) || row.completedAt < 0
    || (row.assistantMessageId !== undefined && (typeof row.assistantMessageId !== "string" || !row.assistantMessageId.trim()))) throw new Error("Invalid turn outcome")
  const base = { completedAt: row.completedAt, ...(row.assistantMessageId === undefined ? {} : { assistantMessageId: row.assistantMessageId }) }
  if (row.status === "completed" || row.status === "cancelled") {
    if (row.reason !== undefined && typeof row.reason !== "string") throw new Error("Invalid turn outcome reason")
    return { ...base, status: row.status, ...(row.reason === undefined ? {} : { reason: row.reason }) }
  }
  if (row.status !== "failed" || typeof row.error !== "string") throw new Error("Invalid failed turn outcome")
  const errorClass = FIRST_TURN_ERROR_CLASSES.find((value) => value === row.errorClass)
  const account = turnAccount(row.account)
  const detail = row.detail
  if ((row.errorClass !== undefined && !errorClass) || (row.account !== undefined && !account)
    || (detail !== undefined && !isStringDetails(detail))) throw new Error("Invalid turn failure details")
  return { ...base, status: "failed", error: row.error, ...(errorClass ? { errorClass } : {}), ...(account ? { account } : {}), ...(detail ? { detail } : {}) }
}

function isStringDetails(value: unknown): value is Record<string, string> {
  const detail = asRecord(value)
  return detail !== undefined && Object.values(detail).every((item) => typeof item === "string")
}
