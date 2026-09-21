/**
 * How this endpoint reads a `RecoveryOutcome` back to a caller: one predicate
 * for whether the turn stopped, one text rendering, and the tool result both
 * are assembled into.
 */
import type {
  RecoveryOperation,
  RecoveryOutcome,
  RecoveryRefusal,
} from "@claxedo/agent-runtime-contract"
import type { McpToolResult } from "../mcp-tool"
import { toolJson } from "./target"

/**
 * A turn stopped when its owner reports execution terminal and the interrupted
 * state committed. `cancel_turn` additionally requires `cleanup:
 * "verified_clear"` to close as `succeeded`, which no adapter can establish, so
 * a healthy Stop settles as `needs_action` with cleanup unknown — reading
 * `state !== "succeeded"` as failure reports every healthy Stop as one.
 */
export function turnStopped(outcome: RecoveryOutcome): boolean {
  if (outcome.kind !== "operation") return false
  const facts = outcome.operation.facts
  return facts.execution.value === "terminal" && facts.persistence.value === "committed"
}

/**
 * A running or unknown execution leaves work the caller has to deal with, and
 * so does an owner that named an error. Unverified cleanup does not: it is a
 * stopped turn whose resources nothing has proven released.
 */
export function recoveryFailed(outcome: RecoveryOutcome): boolean {
  if (outcome.kind === "refused") return true
  return outcome.operation.facts.execution.value !== "terminal" || outcome.operation.state === "failed"
}

export function recoveryText(outcome: RecoveryOutcome): string {
  if (outcome.kind === "refused") return refusalText(outcome.refusal)
  const operation = outcome.operation
  return [
    turnStopped(outcome) ? stoppedText(operation) : unfinishedText(operation),
    evidence(operation),
    ...errorLines(operation),
    ...nextActionLines(operation),
  ].join("\n")
}

/** The summary rides ahead of the payload so a caller reads it without parsing JSON. */
export function recoveryResult(payload: unknown, outcome: RecoveryOutcome): McpToolResult {
  return {
    content: [{ type: "text", text: recoveryText(outcome) }, ...toolJson(payload).content],
    ...(recoveryFailed(outcome) ? { isError: true } : {}),
  }
}

/** Cleanup is the only fact left to read once the turn has stopped and been recorded. */
function stoppedText(operation: RecoveryOperation): string {
  switch (operation.facts.cleanup.value) {
    case "verified_clear":
      return "Stopped. Execution ended, the turn's resources were cleared, and that was recorded."
    case "owned":
      return "Stopped — cleanup not verified. Execution ended and was recorded, and the turn still holds resources nothing has proven released."
    case "unknown":
      return "Stopped — cleanup not verified. Execution ended and was recorded; whether the turn's resources were released is unknown."
  }
}

function unfinishedText(operation: RecoveryOperation): string {
  const { execution, persistence } = operation.facts
  if (execution.value === "running") {
    return "The turn is still running: cancellation reached the owner but did not stop it."
  }
  if (execution.value === "unknown") {
    return "Cancellation did not answer for the turn; whether it is still running is unknown."
  }
  return persistence.value === "pending"
    ? "Execution stopped, but saving the interrupted state has not been committed."
    : "Execution stopped, but the store that records the interrupted state is unavailable, so the stop was not recorded."
}

function evidence(operation: RecoveryOperation): string {
  const { execution, cleanup, persistence } = operation.facts
  const facts = [
    `execution ${execution.value} per ${execution.source}`,
    `cleanup ${cleanup.value} per ${cleanup.source}`,
    `persistence ${persistence.value} per ${persistence.source}`,
  ].join(", ")
  return `Operation ${operation.operationId} is ${operation.state} at phase ${operation.phase}: ${facts}.`
}

function errorLines(operation: RecoveryOperation): string[] {
  const errors = operation.initiatingError ? [operation.initiatingError, ...operation.cleanupErrors] : operation.cleanupErrors
  return errors.map(
    (error) =>
      `Error ${error.code} from ${error.origin} at ${error.stage}: ${error.message}`
      + (error.executionMayContinue ? " Execution may continue." : ""),
  )
}

function nextActionLines(operation: RecoveryOperation): string[] {
  return operation.nextActions.map(
    (next) => `Next: ${next.action} — ${next.reason}`
      + (next.scopePreviewRequired ? " Confirm what it would interrupt first." : ""),
  )
}

function refusalText(refusal: RecoveryRefusal): string {
  switch (refusal.kind) {
    case "generation_conflict":
      return `Refused: that turn has already ended, so nothing was cancelled. ${refusal.message}`
    case "intent_conflict":
      return `Refused: request ${refusal.requestId} was already used for a different command. ${refusal.message}`
    case "receipt_expired":
      return `Refused: the receipt for request ${refusal.requestId} has expired; submit the command again. ${refusal.message}`
    case "scope_changed":
      return [
        `Refused: what this command would interrupt changed since revision ${refusal.scopeRevision} was authorized. ${refusal.message}`,
        `It now reaches ${refusal.preview.summary}`,
        `Sessions: ${list(refusal.preview.sessions)}. Resources: ${list(refusal.preview.resources)}.`,
      ].join("\n")
    case "unauthorized":
      return `Refused: this credential may not run that recovery command. ${refusal.message}`
    case "unavailable":
      return `Refused: the owner is unavailable, so nothing was cancelled. ${refusal.message}`
    case "version_update_required":
      return `Refused: the owner speaks recovery contract version ${refusal.contractVersion} and this client is too old for it. ${refusal.message}`
  }
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none"
}
