/**
 * How a channel reads a stop back to the person who asked for it: whether the
 * turn stopped, whether the thread may be rebound, and the sentence to reply
 * with.
 */
import type { RecoveryOutcome, RecoveryRefusal } from "@claxedo/agent-runtime-contract"
import type { ChannelAbortResult } from "./resolve-session"

/**
 * A turn stopped when its owner reports execution terminal and the interrupted
 * state committed. `cancel_turn` only closes as `succeeded` under `cleanup:
 * "verified_clear"`, which no adapter can establish, so a healthy Stop settles
 * as `needs_action` — replying "Session needs_action." to that told a person
 * their Stop had failed when it had not.
 */
export function turnStopped(outcome: RecoveryOutcome): boolean {
  if (outcome.kind !== "operation") return false
  const facts = outcome.operation.facts
  return facts.execution.value === "terminal" && facts.persistence.value === "committed"
}

/**
 * Whether `/new` may drop the thread's binding. Nothing was running, or what
 * was running has stopped; anything else leaves a turn that could still write
 * to a session the thread has stopped pointing at.
 */
export function abortSettled(result: ChannelAbortResult): boolean {
  if (result.kind === "no_active_turn") return true
  return result.kind === "outcome" && turnStopped(result.outcome)
}

export function abortReplyText(result: ChannelAbortResult): string {
  if (result.kind === "no_active_turn") return "Nothing was running in this session."
  if (result.kind === "unreachable") return result.message
  const outcome = result.outcome
  if (outcome.kind === "refused") return refusalText(outcome.refusal)
  const { execution, cleanup, persistence } = outcome.operation.facts
  if (execution.value === "running") {
    return "The turn is still running: cancelling it did not stop it. Send the command again, or open the session to look."
  }
  if (execution.value === "unknown") {
    return "Cancelling got no answer, so the turn may still be running. Open the session to look."
  }
  if (persistence.value !== "committed") {
    return "The turn stopped, but where it was interrupted was not saved."
  }
  return cleanup.value === "verified_clear"
    ? "Stopped the turn."
    : "Stopped the turn. Whether everything it was using has been released is not verified."
}

function refusalText(refusal: RecoveryRefusal): string {
  switch (refusal.kind) {
    case "generation_conflict":
      return "That turn has already ended."
    case "intent_conflict":
      return "That command was already used for something else. Send it again."
    case "receipt_expired":
      return "The stop took too long to confirm. Send the command again."
    case "scope_changed":
      return `Stopping now would interrupt more than it would have a moment ago: ${refusal.preview.summary}. Send the command again to confirm.`
    case "unauthorized":
      return "You are not allowed to stop this session."
    case "unavailable":
      return "The machine running this session is unavailable, so nothing was stopped."
    case "version_update_required":
      return "The machine running this session needs updating before it can stop a turn."
  }
}
