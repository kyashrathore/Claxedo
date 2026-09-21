import type { RecoveryNextAction, RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { turnStopped } from "@claxedo/agent-runtime-contract"

/**
 * What a Stop reached, read from the three facts.
 *
 * The operation's state is not the test. `cancel_turn`'s contract
 * postcondition requires `cleanup: verified_clear`, which an adapter reports
 * only when it can prove nothing the turn started survives; a harness that
 * cannot prove that leaves cleanup `unknown`, so a healthy local Stop closes as
 * `needs_action`. Reading "not succeeded" as "did not stop" puts a red toast on
 * every working Stop and blocks every mutation that waits on one.
 */
export type RecoveryReading =
  | "stopped"
  | "cleanup_unverified"
  | "save_failed"
  | "unresponsive"
  | "turn_ended"
  | "machine_unavailable"
  | "not_allowed"
  | "different_request"
  | "receipt_expired"
  | "scope_changed"
  | "update_required"
  | "unreachable"

export type RecoveryCopyKey = `session.recovery.${RecoveryReading}.${"title" | "detail"}`

export type RecoveryCopy = {
  reading: RecoveryReading
  titleKey: RecoveryCopyKey
  detailKey: RecoveryCopyKey
  /** The owner's own words, when it gave any. It adds to the detail, never replaces it. */
  ownerMessage?: string
  nextActions: RecoveryNextAction[]
  /**
   * Whether the turn is over and that is recorded. Revert, undo and harness
   * switch rewrite history the turn is still writing, so they wait on this:
   * an interrupted turn whose finish was never committed comes back on the next
   * read and reopens what they just changed.
   */
  stopped: boolean
  /** Whether to show this as a failure. A stopped turn with unproven cleanup is not one. */
  failed: boolean
}

export function describeRecoveryOutcome(outcome: RecoveryOutcome): RecoveryCopy {
  if (outcome.kind === "refused") {
    return readingCopy(REFUSAL_READINGS[outcome.refusal.kind], {
      ownerMessage: outcome.refusal.message,
      nextActions: [],
      stopped: false,
      failed: true,
    })
  }
  const operation = outcome.operation
  const shared = { ownerMessage: ownerMessage(outcome), nextActions: operation.nextActions }
  if (operation.facts.execution.value !== "terminal") {
    return readingCopy("unresponsive", { ...shared, stopped: false, failed: true })
  }
  if (operation.facts.persistence.value !== "committed") {
    return readingCopy("save_failed", { ...shared, stopped: false, failed: true })
  }
  const reading = operation.facts.cleanup.value === "verified_clear" ? "stopped" : "cleanup_unverified"
  return readingCopy(reading, { ...shared, stopped: true, failed: operation.state === "failed" })
}

/** A Stop that never reached an owner: there is no outcome, so there are no facts. */
export function describeRecoveryUnreachable(message: string): RecoveryCopy {
  return readingCopy("unreachable", { ownerMessage: message, nextActions: [], stopped: false, failed: true })
}

/**
 * Structural so this module stays free of the i18n provider: every caller has
 * a translator whose key type is wider than these keys.
 */
export type RecoveryTranslator = (key: RecoveryCopyKey) => string

/** The reading in words, with the owner's own account appended when it gave one. */
export function recoveryToastText(t: RecoveryTranslator, copy: RecoveryCopy) {
  const detail = t(copy.detailKey)
  return {
    title: t(copy.titleKey),
    description: copy.ownerMessage ? `${detail} ${copy.ownerMessage}` : detail,
  }
}

/** The owner's own account of what went wrong, when it gave one. */
export function ownerMessage(outcome: RecoveryOutcome) {
  if (outcome.kind === "refused") return outcome.refusal.message
  return outcome.operation.initiatingError?.message ?? outcome.operation.cleanupErrors[0]?.message
}

const REFUSAL_READINGS: Record<
  Extract<RecoveryOutcome, { kind: "refused" }>["refusal"]["kind"],
  RecoveryReading
> = {
  generation_conflict: "turn_ended",
  intent_conflict: "different_request",
  receipt_expired: "receipt_expired",
  scope_changed: "scope_changed",
  unauthorized: "not_allowed",
  unavailable: "machine_unavailable",
  version_update_required: "update_required",
}

function readingCopy(
  reading: RecoveryReading,
  rest: { ownerMessage?: string; nextActions: RecoveryNextAction[]; stopped: boolean; failed: boolean },
): RecoveryCopy {
  return {
    reading,
    titleKey: `session.recovery.${reading}.title`,
    detailKey: `session.recovery.${reading}.detail`,
    ...(rest.ownerMessage !== undefined ? { ownerMessage: rest.ownerMessage } : {}),
    nextActions: rest.nextActions,
    stopped: rest.stopped,
    failed: rest.failed,
  }
}
