import { randomUUID } from "node:crypto"
import type {
  AgentExecutionBinding,
  RecoveryOperation,
  RecoveryOutcome,
  RecoveryRequest,
  RecoveryTurnTarget,
} from "@claxedo/agent-runtime-contract"
import type { AdapterCancelOutcome, SupportsCancel } from "../adapter-contract"
import type { AgentRuntimeRecovery, RecoveryCaller } from "../runtime/contracts"

/**
 * Call an adapter's cancellation the way the runtime does, with a real deadline
 * and signal. A test that passes its own `withinMs` is exercising what the
 * adapter reports when the deadline runs out, so the default is generous enough
 * that a healthy adapter never hits it.
 */
export function cancelAdapterTurn(
  adapter: Partial<SupportsCancel>,
  binding: AgentExecutionBinding,
  turn: { turnId?: string; assistantMessageId?: string; withinMs?: number; signal?: AbortSignal } = {},
): Promise<AdapterCancelOutcome> {
  if (!adapter.cancelTurn) throw new Error("This harness does not implement cancelTurn")
  return adapter.cancelTurn(binding, {
    turnId: turn.turnId ?? "msg_test",
    assistantMessageId: turn.assistantMessageId ?? "asst_test",
    signal: turn.signal ?? new AbortController().signal,
    deadlineAt: Date.now() + (turn.withinMs ?? 10_000),
  })
}

export const RECOVERY_TEST_CALLER: RecoveryCaller = { callerId: "test-caller", authority: "session" }

export function cancelTurnRequest(
  target: RecoveryTurnTarget,
  overrides: Partial<RecoveryRequest> = {},
): RecoveryRequest {
  return {
    requestId: `req_${randomUUID()}`,
    action: "cancel_turn",
    target,
    scopeRevision: "1",
    attempt: 1,
    ...overrides,
  }
}

/** Stop a session's current turn the way a caller does: read its identity, then send it back. */
export async function cancelRuntimeTurn(
  runtime: { recovery: AgentRuntimeRecovery },
  sessionId: string,
  overrides: Partial<RecoveryRequest> = {},
): Promise<RecoveryOutcome> {
  const target = runtime.recovery.inspect(sessionId).target
  if (!target) throw new Error(`Session ${sessionId} has no admitted turn to cancel`)
  return await runtime.recovery.submit(cancelTurnRequest(target, overrides), RECOVERY_TEST_CALLER)
}

/** The operation a submit answered with, or a failure naming the refusal it returned. */
export function submittedOperation(outcome: RecoveryOutcome): RecoveryOperation {
  if (outcome.kind === "refused") throw new Error(`recovery refused: ${outcome.refusal.kind} ${outcome.refusal.message}`)
  return outcome.operation
}
