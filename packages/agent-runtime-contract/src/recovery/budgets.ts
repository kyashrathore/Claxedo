import { requireRecoveryNumber, RecoveryContractError } from "./validation"

export type RecoveryBudgets = {
  ackMs: number
  providerQueryMs: number
  gracefulCancelMs: number
  termGraceMs: number
  killVerifyMs: number
  reconcileMs: number
  drainMs: number
}

export const DEFAULT_RECOVERY_BUDGETS: Readonly<RecoveryBudgets> = {
  ackMs: 2000,
  providerQueryMs: 5000,
  gracefulCancelMs: 10000,
  termGraceMs: 3000,
  killVerifyMs: 2000,
  reconcileMs: 30000,
  drainMs: 30000,
}

/**
 * The deadline a child phase may run to. The parent caps it, so a sequence of
 * child phases cannot multiply the deadline the caller was promised. An already
 * expired parent yields `now`, which every phase treats as no time left.
 */
export function capChildBudget(parentDeadlineAt: number, childMs: number, now: number): number {
  requireRecoveryNumber(parentDeadlineAt, "invalid_budget", "parentDeadlineAt")
  requireRecoveryNumber(childMs, "invalid_budget", "childMs")
  requireRecoveryNumber(now, "invalid_budget", "now")
  if (childMs < 0) throw new RecoveryContractError("invalid_budget", "recovery child budget must not be negative")
  return Math.max(now, Math.min(parentDeadlineAt, now + childMs))
}
