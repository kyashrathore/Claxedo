import type { ChannelAbortResult } from "./resolve-session"

/**
 * What a local Stop settles as. `cancel_turn` only closes as `succeeded` under
 * `cleanup: "verified_clear"`, which no adapter can establish, so a healthy
 * Stop is `needs_action` with cleanup unknown. A fake that answered `ok: true`
 * to anything hid exactly the reading defect these tests are here to catch.
 */
export function stoppedTurn(sessionId: string): ChannelAbortResult {
  const evidence = <V extends string>(value: V) => ({ value, source: "fixture", observedAt: 1, generation: "gen_1" })
  const target = {
    scope: "turn" as const,
    workspaceId: "ws_fixture",
    sessionId,
    turnId: `turn_${sessionId}`,
    ownerGeneration: "gen_1",
  }
  return {
    kind: "outcome",
    outcome: {
      kind: "operation",
      operation: {
        operationId: `op_${sessionId}`, requestId: `req_${sessionId}`, target, action: "cancel_turn",
        scopeRevision: "gen_1", attempt: 1, state: "needs_action", phase: "graceful_cancel", phaseDeadlineAt: 2,
        facts: { execution: evidence("terminal"), cleanup: evidence("unknown"), persistence: evidence("committed") },
        cleanupErrors: [],
        nextActions: [{ action: "inspect", scopePreviewRequired: false, reason: "confirm the turn released its resources" }],
        receipt: "durable", createdAt: 1, updatedAt: 1,
      },
    },
  }
}

/** A cancellation the provider never acted on: the harness is still running. */
export function stillRunning(sessionId: string): ChannelAbortResult {
  const stopped = stoppedTurn(sessionId)
  if (stopped.kind !== "outcome" || stopped.outcome.kind !== "operation") throw new Error("the fixture builds an operation")
  const operation = stopped.outcome.operation
  return {
    kind: "outcome",
    outcome: {
      kind: "operation",
      operation: {
        ...operation,
        state: "failed",
        facts: { ...operation.facts, execution: { ...operation.facts.execution, value: "running" } },
        initiatingError: {
          code: "cancellation_timeout",
          origin: "fixture-owner",
          target: operation.target,
          stage: "graceful_cancel",
          executionMayContinue: true,
          message: "the provider never acknowledged the cancellation",
          at: 2,
        },
        nextActions: [{ action: "cancel_turn", scopePreviewRequired: false, reason: "retry the cancellation" }],
      },
    },
  }
}
