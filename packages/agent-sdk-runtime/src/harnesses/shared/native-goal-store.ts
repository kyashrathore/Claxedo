import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"

/**
 * The slash command that puts a native harness session into Goal mode.
 *
 * CROSS-HARNESS PROTOCOL CONSTANT: Claude and Cursor both accept it verbatim as
 * a prompt, and the composer recognises the same prefix when a user types it by
 * hand — so the wording is a contract, not a per-driver detail.
 */
export const NATIVE_GOAL_COMMAND = "/goal"

export function nativeGoalCommand(objective: string) {
  return `${NATIVE_GOAL_COMMAND} ${objective}`
}

/** How a Goal that outlived its turn without a provider verdict is settled. */
export type NativeGoalSettlement = {
  status: Exclude<RuntimeGoalSnapshot["status"], "active">
  reason?: string
}

/**
 * The in-memory Goal state a native SDK driver owns for its live sessions.
 *
 * Claude and Cursor both drive Goal through a provider session that reports
 * progress on the turn stream, so the driver is authoritative only while that
 * process lives: this map IS the `nativeGoal.read`/`stop` answer, and it is
 * deliberately not durable. The adapter projects the durable copy and recovers
 * from it after a restart.
 */
export type NativeGoalStore = {
  /** `nativeGoal.read`: the driver's authoritative snapshot, or none. */
  read(sessionId: string): Promise<RuntimeGoalSnapshot | null>
  /** Synchronous peek, for building the next snapshot from the current one. */
  peek(sessionId: string): RuntimeGoalSnapshot | undefined
  /** Record the provider's latest snapshot; `null` clears it. */
  apply(sessionId: string, goal: RuntimeGoalSnapshot | null): void
  /** `nativeGoal.stop`: pause a live Goal, or report that none exists. */
  stop(sessionId: string): Promise<RuntimeGoalSnapshot | null>
  /**
   * Settle a Goal whose turn ended without the provider reporting an outcome —
   * the stream or the run result threw. Returns the settled snapshot to publish,
   * or `null` when there is nothing left running to settle (no Goal, or the
   * provider already moved it off `active`).
   */
  settleUnfinished(sessionId: string, settlement: NativeGoalSettlement): RuntimeGoalSnapshot | null
  /** Drop the session's Goal state when the session itself goes away. */
  forget(sessionId: string): void
}

export function createNativeGoalStore(): NativeGoalStore {
  const goals = new Map<string, RuntimeGoalSnapshot>()
  const store: NativeGoalStore = {
    read: async (sessionId) => goals.get(sessionId) ?? null,
    peek: (sessionId) => goals.get(sessionId),
    apply(sessionId, goal) {
      if (goal) goals.set(sessionId, goal)
      else goals.delete(sessionId)
    },
    stop: async (sessionId) => {
      const goal = goals.get(sessionId)
      if (!goal) return null
      const stopped: RuntimeGoalSnapshot = { ...goal, status: "paused", updatedAt: Date.now() }
      goals.set(sessionId, stopped)
      return stopped
    },
    settleUnfinished(sessionId, settlement) {
      const goal = goals.get(sessionId)
      if (!goal || goal.status !== "active") return null
      const settled: RuntimeGoalSnapshot = {
        ...goal,
        status: settlement.status,
        updatedAt: Date.now(),
        ...(settlement.reason ? { lastReason: settlement.reason } : {}),
      }
      goals.set(sessionId, settled)
      return settled
    },
    forget(sessionId) {
      goals.delete(sessionId)
    },
  }
  return store
}
