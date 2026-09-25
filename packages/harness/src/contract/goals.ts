import { isRuntimeGoalStatus, type RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"

export function goalSnapshotFromRecord(sessionId: string, value: unknown, options: {
  invalid: () => Error
  now?: number
  status?: (value: unknown) => unknown
}): RuntimeGoalSnapshot {
  const row = asRecordOrEmpty(value)
  const status = options.status ? options.status(row.status) : row.status
  if (typeof row.objective !== "string" || !isRuntimeGoalStatus(status) ||
    (options.now === undefined && (typeof row.createdAt !== "number" || typeof row.updatedAt !== "number"))) {
    throw options.invalid()
  }
  return { sessionId, objective: row.objective, status,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : options.now!,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : options.now!,
    ...(typeof row.iteration === "number" ? { iteration: row.iteration } : {}),
    ...(typeof row.lastReason === "string" ? { lastReason: row.lastReason } : {}),
    ...(typeof row.tokenBudget === "number" ? { tokenBudget: row.tokenBudget } : {}),
    ...(typeof row.tokensUsed === "number" ? { tokensUsed: row.tokensUsed } : {}),
    ...(typeof row.timeUsedSeconds === "number" ? { timeUsedSeconds: row.timeUsedSeconds } : {}) }
}
