import { type RecoveryTargetScope, RECOVERY_TARGET_SCOPES, type RecoveryTarget, parseRecoveryTarget } from "./targets"
import { member, RecoveryContractError } from "./validation"

export const RECOVERY_ACTIONS = [
  "inspect",
  "cancel_turn",
  "reconcile_session",
  "retire_harness",
  "drain_daemon",
  "stop_daemon",
  "release_drain",
] as const

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

export const RECOVERY_MUTATING_ACTIONS = [
  "cancel_turn",
  "reconcile_session",
  "retire_harness",
  "drain_daemon",
  "stop_daemon",
  "release_drain",
] as const

export type RecoveryMutatingAction = (typeof RECOVERY_MUTATING_ACTIONS)[number]

/**
 * `read_operation` reads an existing operation by id, so it is not itself a
 * `RecoveryAction`: it has no target, no scope and no receipt of its own.
 */
export const RECOVERY_READ_ACTIONS = ["inspect", "read_operation"] as const

export type RecoveryReadAction = (typeof RECOVERY_READ_ACTIONS)[number]

export function isMutatingRecoveryAction(action: RecoveryAction): action is RecoveryMutatingAction {
  return member(RECOVERY_MUTATING_ACTIONS, action)
}

/**
 * Which target an action may name. `reconcile_session` accepts a turn so a
 * caller can narrow reconciliation to one turn of a session; every other
 * action has exactly the owner its postcondition is written against.
 */
export const RECOVERY_ACTION_SCOPES: Readonly<Record<RecoveryAction, readonly RecoveryTargetScope[]>> = {
  inspect: RECOVERY_TARGET_SCOPES,
  cancel_turn: ["turn"],
  reconcile_session: ["session", "turn"],
  retire_harness: ["harness"],
  drain_daemon: ["machine"],
  stop_daemon: ["machine"],
  release_drain: ["machine"],
}

/** Incoming requests and published operations must obey the same action-to-owner constraint. */
export function scopedTarget(action: RecoveryAction, input: unknown): RecoveryTarget {
  const target = parseRecoveryTarget(input)
  if (!RECOVERY_ACTION_SCOPES[action].includes(target.scope)) {
    throw new RecoveryContractError("scope_mismatch", `recovery action ${action} cannot target a ${target.scope}`)
  }
  return target
}
