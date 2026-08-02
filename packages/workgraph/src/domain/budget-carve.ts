import type { ExecutionBudget, ExecutionProfileDefaults } from "../contracts/execution"

export type ExecutionBudgetCarveResult =
  | Readonly<{
      ok: true
      parent: ExecutionProfileDefaults
      child: ExecutionProfileDefaults
    }>
  | Readonly<{
      ok: false
      error: "parent_budget_required" | "budget_shape_mismatch" | "insufficient_parent_budget"
    }>

export function carveExecutionBudget(
  parent: ExecutionProfileDefaults,
  requested: ExecutionProfileDefaults | undefined,
  carve: ExecutionBudget | undefined,
): ExecutionBudgetCarveResult {
  if (!carve) return { ok: true, parent, child: { ...parent, ...(requested ?? {}) } }
  if (!parent.budget) return { ok: false, error: "parent_budget_required" }
  if (parent.budget.unit !== carve.unit || parent.budget.window !== carve.window) {
    return { ok: false, error: "budget_shape_mismatch" }
  }
  if (parent.budget.amount <= carve.amount) return { ok: false, error: "insufficient_parent_budget" }
  return {
    ok: true,
    parent: {
      ...parent,
      budget: { ...parent.budget, amount: parent.budget.amount - carve.amount },
    },
    child: {
      ...parent,
      ...(requested ?? {}),
      budget: carve,
    },
  }
}
