import type { RuntimeGoalSnapshot } from "./subagents"

export type AgentGoalStartInput = {
  objective: string
}

export type AgentGoalMutationFailure = {
  ok: false
  status: "unsupported" | "unavailable" | "not_found" | "conflict" | "failed"
  message: string
}

export type AgentGoalMutationResult<Goal extends RuntimeGoalSnapshot | null = RuntimeGoalSnapshot | null> =
  | { ok: true; goal: Goal }
  | AgentGoalMutationFailure

export type GoalAction = "pause" | "resume" | "delete"

export type GoalRecovery = "reconcile" | "blocked"

export type GoalOptionalField = "tokenBudget" | "tokensUsed" | "timeUsedSeconds" | "iteration" | "lastReason"

export type GoalCapabilities = {
  /** Whether this adapter contains a real Goal implementation. */
  implemented: boolean
  /** Whether that implementation can be used in the current session/runtime. */
  available: boolean
  unavailableReason?: string
  actions: readonly GoalAction[]
  /** Whether authoritative state can be reconciled after reconnect/reload. */
  recovery: GoalRecovery
  /** Optional snapshot fields this implementation may report without fabrication. */
  optionalFields: readonly GoalOptionalField[]
}
