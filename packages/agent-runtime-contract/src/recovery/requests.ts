import { asRecord, asText } from "../values"
import { type RecoveryAction, RECOVERY_ACTIONS, scopedTarget } from "./actions"
import { type RecoveryTarget, normalizeRecoveryTarget } from "./targets"
import { RecoveryContractError, member, requireRecoveryText } from "./validation"

/**
 * The drain a `release_drain` reopens, by operation id.
 *
 * Releasing is always about one earlier operation's gates, never about "the
 * fence" in general: two drains can hold overlapping owners, and reopening
 * whatever happens to be closed would un-gate a scope its own caller never
 * authorized reopening. The id rides in `linkedOperationId`, which is the field
 * for exactly this — a request that names another operation — so a release
 * without one is refused before it reaches an owner.
 */
export function releasedDrainOperationId(request: RecoveryRequest): string | undefined {
  return request.action === "release_drain" ? request.linkedOperationId : undefined
}

export type RecoveryRequest = {
  /** Unique per caller, not globally: two callers may reuse the same string. */
  requestId: string
  action: RecoveryAction
  target: RecoveryTarget
  /** The revision of the impact scope the caller was shown and authorized. */
  scopeRevision: string
  attempt: number
  /** The failed operation an explicit retry, or a nested child, is linked to. */
  linkedOperationId?: string
}

/**
 * The part of a request that decides whether a second delivery of the same
 * request id is the same command. Attempt and request id are excluded: a retry
 * is a new attempt of one intent, and the id is the key being compared under.
 */
export type RecoveryIntent = {
  action: RecoveryAction
  scopeRevision: string
  target: RecoveryTarget
  linkedOperationId?: string
}

/**
 * Key order comes from the literals here rather than from the caller's object,
 * so `JSON.stringify` of the result is canonical and can be stored as the
 * column an owner compares a repeated request id against.
 */
export function normalizeRecoveryIntent(request: RecoveryRequest): RecoveryIntent {
  return {
    action: request.action,
    scopeRevision: request.scopeRevision,
    target: normalizeRecoveryTarget(request.target),
    ...(request.linkedOperationId !== undefined ? { linkedOperationId: request.linkedOperationId } : {}),
  }
}

/** Repeated deliveries must compare canonical intent rather than caller-supplied key order. */
export function recoveryIntentEquals(a: RecoveryRequest, b: RecoveryRequest): boolean {
  return JSON.stringify(normalizeRecoveryIntent(a)) === JSON.stringify(normalizeRecoveryIntent(b))
}

export function parseRecoveryRequest(input: unknown): RecoveryRequest {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_payload", "recovery request must be an object")
  const requestId = asText(row.requestId)
  if (requestId === undefined) throw new RecoveryContractError("invalid_request_id", "recovery requestId is required")
  if (!member(RECOVERY_ACTIONS, row.action)) {
    throw new RecoveryContractError("invalid_action", `unknown recovery action ${JSON.stringify(row.action)}`)
  }
  const attempt = row.attempt
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new RecoveryContractError("invalid_attempt", "recovery attempt must be an integer of at least 1")
  }
  const target = scopedTarget(row.action, row.target)
  return {
    requestId,
    action: row.action,
    target,
    scopeRevision: requireRecoveryText(row.scopeRevision, "invalid_scope_revision", "scopeRevision"),
    attempt,
    ...(row.linkedOperationId !== undefined
      ? { linkedOperationId: requireRecoveryText(row.linkedOperationId, "invalid_operation", "linkedOperationId") }
      : {}),
  }
}
