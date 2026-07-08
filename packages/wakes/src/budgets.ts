import type { Budgets, WorkspaceId } from "./types"
import type { WakeStore } from "./store"

export class BudgetError extends Error {
  constructor(
    public reason: "max_live" | "rate" | "horizon" | "depth",
    message: string,
  ) {
    super(message)
    this.name = "BudgetError"
  }
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export function resolveBudgets(b?: Budgets): Required<Budgets> {
  return {
    maxLiveWakes: b?.maxLiveWakes ?? 1000,
    creationRatePerHour: b?.creationRatePerHour ?? 240,
    maxHorizonMs: b?.maxHorizonMs ?? 90 * DAY_MS,
    maxDepth: b?.maxDepth ?? 5,
  }
}

/**
 * Enforce per-workspace limits at the create path. Throws BudgetError on breach.
 * `fireAt` is checked against the horizon only when present (time triggers).
 */
export function enforceBudgets(
  store: WakeStore,
  limits: Required<Budgets>,
  input: { workspaceId: WorkspaceId; depth: number; fireAt: number | null; nowMs: number },
): void {
  if (input.depth > limits.maxDepth) {
    throw new BudgetError("depth", `self-schedule depth ${input.depth} exceeds max ${limits.maxDepth}`)
  }
  if (input.fireAt !== null && input.fireAt > input.nowMs + limits.maxHorizonMs) {
    throw new BudgetError("horizon", `fireAt exceeds max horizon of ${limits.maxHorizonMs}ms`)
  }
  if (store.countLive(input.workspaceId) >= limits.maxLiveWakes) {
    throw new BudgetError("max_live", `workspace has too many live wakes (max ${limits.maxLiveWakes})`)
  }
  if (store.countCreatedSince(input.workspaceId, input.nowMs - HOUR_MS) >= limits.creationRatePerHour) {
    throw new BudgetError("rate", `wake creation rate exceeded (max ${limits.creationRatePerHour}/h)`)
  }
}
