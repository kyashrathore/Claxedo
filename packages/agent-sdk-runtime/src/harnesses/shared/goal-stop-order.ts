import type { AgentGoalMutationResult } from "../../adapter-contract"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"

/** The slice of a session turn lifecycle a Goal stop needs. */
export type GoalTurnInterrupt = {
  abort(sessionId: string): boolean
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
export async function interruptGoalTurn(sessionId: string, lifecycle: GoalTurnInterrupt) {
  if (lifecycle.abort(sessionId)) await lifecycle.whenIdle(sessionId)
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
}): Promise<AgentGoalMutationResult<Goal>> {
  const disabled = await input.disableContinuation()
  if (!disabled.ok) return disabled
  await interruptGoalTurn(input.sessionId, input.lifecycle)
  return input.settle ? await input.settle() : disabled
}
