import { type RecoveryAction } from "./actions"
import { type ExecutionFact, type CleanupFact, type PersistenceFact, type RecoveryFacts } from "./facts"
import { type RecoveryOutcome } from "./outcomes"

type RecoveryPostcondition = {
  execution?: ExecutionFact
  cleanup?: CleanupFact
  persistence?: PersistenceFact
}

/**
 * What each action advertises when it reports `succeeded`. Inspection asserts
 * nothing about the target, so it can succeed over a running turn; an emergency
 * daemon stop cannot promise a commit, because exiting may lose observations
 * that were never written.
 *
 * `release_drain` asserts nothing either, and for the opposite reason to
 * inspection: it reopens a gate, so its postcondition is about the gate rather
 * than about the target. Requiring `terminal` would make a successful release
 * impossible by construction — the machine it reopens is one that is still
 * running work, which is the whole point of releasing instead of stopping.
 */
const RECOVERY_POSTCONDITIONS: Readonly<Record<RecoveryAction, RecoveryPostcondition>> = {
  inspect: {},
  cancel_turn: { execution: "terminal", cleanup: "verified_clear", persistence: "committed" },
  reconcile_session: { persistence: "committed" },
  retire_harness: { execution: "terminal", cleanup: "verified_clear", persistence: "committed" },
  drain_daemon: { execution: "terminal", cleanup: "verified_clear", persistence: "committed" },
  stop_daemon: { execution: "terminal", cleanup: "verified_clear" },
  release_drain: {},
}

export function recoveryPostconditionHolds(action: RecoveryAction, facts: RecoveryFacts): boolean {
  const required = RECOVERY_POSTCONDITIONS[action]
  return (required.execution === undefined || facts.execution.value === required.execution)
    && (required.cleanup === undefined || facts.cleanup.value === required.cleanup)
    && (required.persistence === undefined || facts.persistence.value === required.persistence)
}

/**
 * Whether the turn is over and the record of it is durable: the postcondition a
 * dependent mutation waits on, and the only honest reading of "it stopped".
 *
 * The operation's state is not that test. `cancel_turn` additionally requires
 * `cleanup: verified_clear` to reach `succeeded`, which an adapter reports only
 * when it can prove nothing the turn started survives; a harness that cannot
 * prove it leaves cleanup `unknown`, so a working cancellation closes as
 * `needs_action`. Reading that as "did not stop" marks every healthy Stop a
 * failure and blocks the revert, undo and handoff that need only the turn to be
 * over and written down. Cleanup stays a separate fact rather than a weaker
 * form of this one.
 */
export function turnStopped(outcome: RecoveryOutcome): boolean {
  return outcome.kind === "operation"
    && outcome.operation.facts.execution.value === "terminal"
    && outcome.operation.facts.persistence.value === "committed"
}
