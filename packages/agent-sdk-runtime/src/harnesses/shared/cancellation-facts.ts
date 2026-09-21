import type { CleanupFact, RecoveryErrorCode } from "@claxedo/agent-runtime-contract"
import { RecoveryCodedError, retirementSettled, type RetirementResult } from "../../launch"

export type CancellationFailure = { code: RecoveryErrorCode; message: string }

export function cancellationErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Keeps a coded cancellation error's own code; everything else takes the caller's. */
export function cancellationFailure(error: unknown, fallback: RecoveryErrorCode): CancellationFailure {
  if (error instanceof RecoveryCodedError) return { code: error.code, message: error.message }
  return { code: fallback, message: cancellationErrorText(error) }
}

/**
 * What a launch retirement established about the resources a turn leaves
 * behind. `verified_clear` requires the launch protocol's own proof that the
 * payload never ran, so a group that has merely stopped answering reports
 * `unknown` and an unresolved leader or group reports `owned`.
 */
export function cleanupFromRetirement(result: RetirementResult): CleanupFact {
  if (result.descendants === "owned" || result.leader !== "exited") return "owned"
  if (result.descendants === "verified_clear" && retirementSettled(result)) return "verified_clear"
  return "unknown"
}

export type TurnStopAttempt = {
  startedAt: number
  settledAt?: number
  failure?: CancellationFailure
}

/**
 * What a turn's own owner observed while stopping it, read by `cancelTurn`
 * after the producer settles. A driver records its attempts here instead of
 * discarding them, because the producer leaving its loop says nothing about
 * whether the provider accepted the cancellation that asked it to.
 */
export type TurnStopRecord = {
  attempts: TurnStopAttempt[]
  /** Set once this turn's owner retired a process it launched. */
  cleanup?: CleanupFact
}

export function createTurnStopRecord(): TurnStopRecord {
  return { attempts: [] }
}

export function observeStopAttempt<T>(
  record: TurnStopRecord,
  fallback: RecoveryErrorCode,
  run: () => Promise<T>,
): Promise<T> {
  const attempt: TurnStopAttempt = { startedAt: Date.now() }
  record.attempts.push(attempt)
  return run().then(
    (value) => {
      attempt.settledAt = Date.now()
      return value
    },
    (error: unknown) => {
      attempt.settledAt = Date.now()
      attempt.failure = cancellationFailure(error, fallback)
      throw error
    },
  )
}

/** The newest attempt's failure. A later successful retry clears it by being newer. */
export function stopFailure(record: TurnStopRecord | undefined): CancellationFailure | undefined {
  return record?.attempts.at(-1)?.failure
}
