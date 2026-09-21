import type { AgentGoalMutationFailure, AgentGoalMutationResult } from "../../adapter-contract"
import { RecoveryCodedError, type RequestDeadline } from "../../launch"
import { stoppedWaiting } from "./sdk-runtime-cancellation"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"

/** The slice of a session turn lifecycle a Goal stop needs. */
export type GoalTurnInterrupt = {
  abort(sessionId: string, deadline?: RequestDeadline): boolean
  whenIdle(sessionId: string): Promise<void>
}

/**
 * Interrupt the work turn of a Goal whose continuation is ALREADY disabled.
 *
 * The await is the point: a Goal turn that is still finishing can publish one
 * more snapshot or admit one more provider turn, so a caller that settles
 * before the session goes idle can report a stopped Goal that immediately
 * reports itself active again. Nothing is awaited when no turn is registered,
 * because that session has no admitted provider work to release.
 */
export async function interruptGoalTurn(sessionId: string, lifecycle: GoalTurnInterrupt, deadline: RequestDeadline) {
  if (!lifecycle.abort(sessionId, deadline)) return
  // The wait is bounded by the same deadline the stop carries: a Goal stop
  // that waits past it reports nothing later than a caller that has gone.
  const idle = await Promise.race([
    lifecycle.whenIdle(sessionId).then(() => true as const),
    stoppedWaiting(deadline),
  ])
  if (!idle) {
    throw new RecoveryCodedError(
      "cancellation_timeout",
      `The Goal turn on session ${sessionId} had not left its producer when the deadline passed`,
    )
  }
}

/**
 * A Goal stop whose interrupt failed is a failed stop. Continuation is already
 * disabled, but the turn it was meant to end was not established as stopped,
 * and answering with the disabled Goal would report work as paused that this
 * owner never reached.
 */
function interruptFailure(error: unknown): AgentGoalMutationFailure {
  return { ok: false, status: "failed", message: error instanceof Error ? error.message : String(error) }
}

/**
 * Run a Goal stop, pause, or delete in the one safe order:
 * disable continuation, interrupt the in-flight turn, wait for the session to
 * release it, and only then settle.
 *
 * `disableContinuation` must be the operation that stops the provider admitting
 * further Goal work; its failure is returned untouched and nothing is
 * interrupted. `settle` is for the step that may only run once nothing can
 * re-report the Goal — clearing it at the provider, for instance. Without one,
 * the disabling operation's own result is the answer.
 */
export async function settleGoalStop<Goal extends RuntimeGoalSnapshot | null>(input: {
  sessionId: string
  lifecycle: GoalTurnInterrupt
  disableContinuation: () => Promise<AgentGoalMutationResult<Goal>>
  settle?: () => Promise<AgentGoalMutationResult<Goal>>
  /** Bounds the interrupt and the wait for the turn to leave its producer. */
  deadline: RequestDeadline
}): Promise<AgentGoalMutationResult<Goal>> {
  const disabled = await input.disableContinuation()
  if (!disabled.ok) return disabled
  try {
    await interruptGoalTurn(input.sessionId, input.lifecycle, input.deadline)
  } catch (error) {
    return interruptFailure(error)
  }
  return input.settle ? await input.settle() : disabled
}
