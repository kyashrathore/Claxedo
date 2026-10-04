import { DEFAULT_RECOVERY_BUDGETS, capChildBudget } from "./budgets"
import { codeOf } from "./fixtures.test"
import { describe, test, expect } from "bun:test"

describe("phase budgets", () => {
  test("a child phase never runs past its parent deadline", () => {
    const parentDeadlineAt = 1_000 + DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs
    expect(capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.providerQueryMs, 1_000)).toBe(6_000)
    expect(capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.reconcileMs, 1_000)).toBe(parentDeadlineAt)
  })

  test("sequential child phases do not multiply the parent deadline", () => {
    const parentDeadlineAt = 1_000 + DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs
    const first = capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.termGraceMs, 1_000)
    const second = capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.killVerifyMs, first)
    const third = capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.drainMs, second)
    expect(third).toBe(parentDeadlineAt)
  })

  test("an expired parent leaves no time at all", () => {
    expect(capChildBudget(900, DEFAULT_RECOVERY_BUDGETS.ackMs, 1_000)).toBe(1_000)
  })

  test.each([
    [Number.NaN, 1_000, 0],
    [1_000, Number.POSITIVE_INFINITY, 0],
    [1_000, 100, Number.NaN],
    [1_000, -1, 0],
  ])("rejects a non-finite or negative budget (%p, %p, %p)", (parentDeadlineAt, childMs, now) => {
    expect(codeOf(() => capChildBudget(parentDeadlineAt, childMs, now))).toBe("invalid_budget")
  })
})
