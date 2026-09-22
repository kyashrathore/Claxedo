import type { RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { captureException } from "@/platform/telemetry/analytics"

/**
 * Why a Stop did not leave the turn ended and recorded. The owner's recovery
 * vocabulary is operator detail: it goes to error reporting, never to the
 * person who pressed Stop.
 */
export type StopFailureKind =
  | "still_running"
  | "not_saved"
  | "unreachable"
  | `refused_${Extract<RecoveryOutcome, { kind: "refused" }>["refusal"]["kind"]}`

export function stopFailureKind(outcome: RecoveryOutcome): StopFailureKind {
  if (outcome.kind === "refused") return `refused_${outcome.refusal.kind}`
  return outcome.operation.facts.execution.value === "terminal" ? "not_saved" : "still_running"
}

/**
 * The kind is in the error message so reports group by cause; ids and the
 * owner's words ride as properties, where they would otherwise split one cause
 * into a group per session.
 */
export function reportStopFailure(input: { sessionID: string; directory?: string } & (
  | { outcome: RecoveryOutcome }
  | { error: unknown }
)) {
  const scope = { surface: "session" as const, session_id: input.sessionID, directory: input.directory }
  if ("error" in input) {
    captureException(new Error("Stop did not stop the turn: unreachable", { cause: input.error }), {
      ...scope,
      stop_failure: "unreachable",
      owner_message: input.error instanceof Error ? input.error.message : String(input.error),
    })
    return
  }
  const kind = stopFailureKind(input.outcome)
  const error = new Error(`Stop did not stop the turn: ${kind}`)
  if (input.outcome.kind === "refused") {
    captureException(error, { ...scope, stop_failure: kind, owner_message: input.outcome.refusal.message })
    return
  }
  const operation = input.outcome.operation
  captureException(error, {
    ...scope,
    stop_failure: kind,
    operation_id: operation.operationId,
    operation_state: operation.state,
    operation_phase: operation.phase,
    attempt: operation.attempt,
    execution: operation.facts.execution.value,
    cleanup: operation.facts.cleanup.value,
    persistence: operation.facts.persistence.value,
    owner_message: operation.initiatingError?.message ?? operation.cleanupErrors[0]?.message,
    initiating_error_code: operation.initiatingError?.code,
  })
}
