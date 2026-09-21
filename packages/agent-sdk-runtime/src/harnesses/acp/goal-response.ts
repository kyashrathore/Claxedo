import { isRuntimeGoalStatus, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { asRecord } from "@claxedo/agent-runtime-contract"
import type { ACPGoalExtension } from "./session"

export function normalizeACPGoal(input: unknown, sessionId: string, extension: ACPGoalExtension | null): RuntimeGoalSnapshot | null {
  if (input === null) return null
  const outer = asRecord(input)
  const value = outer && "goal" in outer ? outer.goal : input
  if (value === null) return null
  const row = asRecord(value)
  if (!row) throw new Error("ACP Goal response is malformed")
  if (
    typeof row.objective !== "string"
    || !isRuntimeGoalStatus(row.status)
    || typeof row.createdAt !== "number"
    || typeof row.updatedAt !== "number"
  ) throw new Error("ACP Goal response is missing required fields")
  const result: RuntimeGoalSnapshot = {
    sessionId,
    objective: row.objective,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  for (const field of extension?.optionalFields ?? []) {
    const item = row[field]
    if (field === "lastReason") {
      if (typeof item === "string") result.lastReason = item
    } else if (typeof item === "number" && Number.isFinite(item)) {
      result[field] = item
    }
  }
  return result
}
