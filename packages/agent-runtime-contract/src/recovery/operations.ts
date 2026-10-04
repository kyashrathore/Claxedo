import { asRecord } from "../values"
import { type RecoveryAction, RECOVERY_ACTIONS, scopedTarget } from "./actions"
import { DEFAULT_RECOVERY_BUDGETS } from "./budgets"
import { type RecoveryFacts, parseRecoveryFacts } from "./facts"
import { recoveryPostconditionHolds } from "./postconditions"
import { type RecoveryTarget, parseRecoveryTarget } from "./targets"
import { RecoveryContractError, member, requireRecoveryText, requireRecoveryNumber } from "./validation"

export const RECOVERY_OPERATION_STATES = ["accepted", "running", "succeeded", "failed", "needs_action"] as const

export type RecoveryOperationState = (typeof RECOVERY_OPERATION_STATES)[number]

export const RECOVERY_PHASES = [
  "ack",
  "provider_query",
  "graceful_cancel",
  "term_grace",
  "kill_verify",
  "reconcile",
  "drain",
] as const

export type RecoveryPhase = (typeof RECOVERY_PHASES)[number]

/** A volatile receipt was never durably recorded and never survives a restart. */
export type RecoveryReceipt = "durable" | "volatile"

export type RecoveryNextAction = {
  action: RecoveryAction
  scopePreviewRequired: boolean
  reason: string
}

export const RECOVERY_ERROR_CODES = [
  "provider_unreachable",
  "cancellation_unsupported",
  "cancellation_timeout",
  "signal_denied",
  "exit_unverified",
  "ownership_unverified",
  "persistence_unavailable",
  "projection_failed",
  "generation_retired",
  "authority_lost",
  "deadline_exceeded",
  "owner_unavailable",
  "internal_error",
] as const

export type RecoveryErrorCode = (typeof RECOVERY_ERROR_CODES)[number]

/**
 * `message` is the whole public payload by construction: there is no free-form
 * details field, so a credential or a raw tool argument has nowhere to ride
 * out to a caller.
 */
export type RecoveryError = {
  code: RecoveryErrorCode
  /** The owner that reported it, by its own name. */
  origin: string
  target: RecoveryTarget
  stage: RecoveryPhase
  executionMayContinue: boolean
  message: string
  at: number
}

export type RecoveryOperation = {
  operationId: string
  requestId: string
  target: RecoveryTarget
  action: RecoveryAction
  scopeRevision: string
  attempt: number
  state: RecoveryOperationState
  phase: RecoveryPhase
  phaseDeadlineAt: number
  facts: RecoveryFacts
  initiatingError?: RecoveryError
  cleanupErrors: RecoveryError[]
  nextActions: RecoveryNextAction[]
  receipt: RecoveryReceipt
  linkedOperationId?: string
  createdAt: number
  updatedAt: number
}

/**
 * How long a settled recovery operation stays listed and stored. Ten reconcile
 * budgets: long enough that a caller which lost its connection can still read
 * its own receipt, short enough that the list is current work. An operation
 * whose facts still show cleanup owned or unknown, or persistence pending, is
 * exempt at every layer: it is the only record of an undischarged obligation.
 */
export const RECOVERY_OPERATION_RETENTION_MS = DEFAULT_RECOVERY_BUDGETS.reconcileMs * 10

/**
 * Applies the latest evidence to an attempt. A terminal attempt keeps its
 * state: later evidence corrects the facts, but an attempt that timed out is
 * not rewritten into a success.
 */
export function finalizeRecoveryOperation(operation: RecoveryOperation, facts: RecoveryFacts): RecoveryOperation {
  const updatedAt = Math.max(
    operation.updatedAt,
    facts.execution.observedAt,
    facts.cleanup.observedAt,
    facts.persistence.observedAt,
  )
  if (operation.state === "succeeded" || operation.state === "failed") return { ...operation, facts, updatedAt }
  if (recoveryPostconditionHolds(operation.action, facts)) return { ...operation, facts, updatedAt, state: "succeeded" }
  const known = operation.initiatingError !== undefined || operation.cleanupErrors.length > 0
  return { ...operation, facts, updatedAt, state: known ? "failed" : "needs_action" }
}

export function parseRecoveryError(input: unknown): RecoveryError {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_payload", "recovery error must be an object")
  if (!member(RECOVERY_ERROR_CODES, row.code)) {
    throw new RecoveryContractError("invalid_payload", `unknown recovery error code ${JSON.stringify(row.code)}`)
  }
  if (!member(RECOVERY_PHASES, row.stage)) {
    throw new RecoveryContractError("invalid_payload", `unknown recovery stage ${JSON.stringify(row.stage)}`)
  }
  if (typeof row.executionMayContinue !== "boolean") {
    throw new RecoveryContractError("invalid_payload", "recovery error executionMayContinue is required")
  }
  return {
    code: row.code,
    origin: requireRecoveryText(row.origin, "invalid_payload", "origin"),
    target: parseRecoveryTarget(row.target),
    stage: row.stage,
    executionMayContinue: row.executionMayContinue,
    message: requireRecoveryText(row.message, "invalid_payload", "message"),
    at: requireRecoveryNumber(row.at, "invalid_observed_at", "at"),
  }
}

export function parseRecoveryOperation(input: unknown): RecoveryOperation {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_operation", "recovery operation must be an object")
  if (!member(RECOVERY_ACTIONS, row.action)) {
    throw new RecoveryContractError("invalid_action", `unknown recovery action ${JSON.stringify(row.action)}`)
  }
  if (!member(RECOVERY_OPERATION_STATES, row.state)) {
    throw new RecoveryContractError("invalid_operation", `unknown recovery state ${JSON.stringify(row.state)}`)
  }
  if (!member(RECOVERY_PHASES, row.phase)) {
    throw new RecoveryContractError("invalid_operation", `unknown recovery phase ${JSON.stringify(row.phase)}`)
  }
  if (row.receipt !== "durable" && row.receipt !== "volatile") {
    throw new RecoveryContractError("invalid_operation", `unknown recovery receipt ${JSON.stringify(row.receipt)}`)
  }
  const attempt = row.attempt
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new RecoveryContractError("invalid_attempt", "recovery attempt must be an integer of at least 1")
  }
  if (!Array.isArray(row.cleanupErrors) || !Array.isArray(row.nextActions)) {
    throw new RecoveryContractError("invalid_operation", "recovery cleanupErrors and nextActions are required arrays")
  }
  return {
    operationId: requireRecoveryText(row.operationId, "invalid_operation", "operationId"),
    requestId: requireRecoveryText(row.requestId, "invalid_request_id", "requestId"),
    target: scopedTarget(row.action, row.target),
    action: row.action,
    scopeRevision: requireRecoveryText(row.scopeRevision, "invalid_scope_revision", "scopeRevision"),
    attempt,
    state: row.state,
    phase: row.phase,
    phaseDeadlineAt: requireRecoveryNumber(row.phaseDeadlineAt, "invalid_observed_at", "phaseDeadlineAt"),
    facts: parseRecoveryFacts(row.facts),
    ...(row.initiatingError !== undefined ? { initiatingError: parseRecoveryError(row.initiatingError) } : {}),
    cleanupErrors: row.cleanupErrors.map(parseRecoveryError),
    nextActions: row.nextActions.map(parseNextAction),
    receipt: row.receipt,
    ...(row.linkedOperationId !== undefined
      ? { linkedOperationId: requireRecoveryText(row.linkedOperationId, "invalid_operation", "linkedOperationId") }
      : {}),
    createdAt: requireRecoveryNumber(row.createdAt, "invalid_observed_at", "createdAt"),
    updatedAt: requireRecoveryNumber(row.updatedAt, "invalid_observed_at", "updatedAt"),
  }
}

function parseNextAction(input: unknown): RecoveryNextAction {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_operation", "recovery next action must be an object")
  if (!member(RECOVERY_ACTIONS, row.action)) {
    throw new RecoveryContractError("invalid_action", `unknown recovery action ${JSON.stringify(row.action)}`)
  }
  if (typeof row.scopePreviewRequired !== "boolean") {
    throw new RecoveryContractError("invalid_operation", "recovery next action scopePreviewRequired is required")
  }
  return {
    action: row.action,
    scopePreviewRequired: row.scopePreviewRequired,
    reason: requireRecoveryText(row.reason, "invalid_operation", "reason"),
  }
}
