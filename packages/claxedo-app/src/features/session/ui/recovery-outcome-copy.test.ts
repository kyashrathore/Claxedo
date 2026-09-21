import { describe, expect, test } from "bun:test"
import type { CleanupFact, ExecutionFact, PersistenceFact, RecoveryOperation, RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { describeRecoveryOutcome, describeRecoveryUnreachable, recoveryPanelReachable, recoveryToastText, unresolvedRecoveryOperations } from "./recovery-outcome-copy"

function outcome(
  execution: ExecutionFact,
  cleanup: CleanupFact,
  persistence: PersistenceFact,
  rest?: Partial<Pick<RecoveryOperation, "state" | "nextActions">> & { error?: string },
): RecoveryOutcome {
  const target = {
    scope: "turn" as const,
    workspaceId: "ws_1",
    sessionId: "ses_1",
    turnId: "msg_1",
    ownerGeneration: "lease_1",
  }
  return {
    kind: "operation",
    operation: {
      operationId: "op_1",
      requestId: "req_1",
      target,
      action: "cancel_turn",
      scopeRevision: "lease_1",
      attempt: 1,
      state: rest?.state ?? "needs_action",
      phase: "graceful_cancel",
      phaseDeadlineAt: 2_000,
      facts: {
        execution: { value: execution, source: "codex", observedAt: 1_000, generation: "lease_1" },
        cleanup: { value: cleanup, source: "process-owner", observedAt: 1_000, generation: "lease_1" },
        persistence: { value: persistence, source: "store", observedAt: 1_000, generation: "lease_1" },
      },
      ...(rest?.error
        ? {
            initiatingError: {
              code: "cancellation_timeout" as const,
              origin: "codex",
              target,
              stage: "graceful_cancel" as const,
              executionMayContinue: true,
              message: rest.error,
              at: 1_000,
            },
          }
        : {}),
      cleanupErrors: [],
      nextActions: rest?.nextActions ?? [],
      receipt: "durable",
      createdAt: 1_000,
      updatedAt: 1_000,
    },
  }
}

describe("reading a cancellation's facts", () => {
  test("a proven-clear stop reads as stopped", () => {
    const copy = describeRecoveryOutcome(outcome("terminal", "verified_clear", "committed"))
    expect(copy.reading).toBe("stopped")
    expect(copy.stopped).toBe(true)
    expect(copy.failed).toBe(false)
  })

  // No adapter in this wave can prove `verified_clear`, so this is what a
  // healthy local Stop actually looks like. It must not read as a failure.
  test.each(["unknown", "owned"] as const)("a stop whose cleanup is %s still stopped the turn", (cleanup) => {
    const copy = describeRecoveryOutcome(outcome("terminal", cleanup, "committed"))
    expect(copy.reading).toBe("cleanup_unverified")
    expect(copy.stopped).toBe(true)
    expect(copy.failed).toBe(false)
  })

  test.each(["pending", "unavailable"] as const)("a turn that ended but was saved as %s is not settled", (persistence) => {
    const copy = describeRecoveryOutcome(outcome("terminal", "unknown", persistence))
    expect(copy.reading).toBe("save_failed")
    expect(copy.stopped).toBe(false)
    expect(copy.failed).toBe(true)
  })

  test.each(["running", "unknown"] as const)("execution %s means the harness may still be running it", (execution) => {
    const copy = describeRecoveryOutcome(outcome(execution, "verified_clear", "committed"))
    expect(copy.reading).toBe("unresponsive")
    expect(copy.stopped).toBe(false)
    expect(copy.failed).toBe(true)
  })

  test("a failed attempt over stopped facts is shown as a failure but does not block a dependent mutation", () => {
    const copy = describeRecoveryOutcome(outcome("terminal", "unknown", "committed", { state: "failed" }))
    expect(copy.stopped).toBe(true)
    expect(copy.failed).toBe(true)
  })

  test("the next actions the owner offered are carried through", () => {
    const nextActions = [{ action: "inspect" as const, scopePreviewRequired: false, reason: "cleanup unproven" }]
    expect(describeRecoveryOutcome(outcome("terminal", "unknown", "committed", { nextActions })).nextActions).toEqual(nextActions)
  })
})

describe("reading a refusal", () => {
  test.each([
    ["generation_conflict", "turn_ended"],
    ["intent_conflict", "different_request"],
    ["receipt_expired", "receipt_expired"],
    ["scope_changed", "scope_changed"],
    ["unauthorized", "not_allowed"],
    ["unavailable", "machine_unavailable"],
    ["version_update_required", "update_required"],
  ] as const)("%s reads as %s and never as stopped", (kind, reading) => {
    const refusal = {
      generation_conflict: { kind: "generation_conflict" as const, message: "replaced" },
      intent_conflict: { kind: "intent_conflict" as const, message: "reused", requestId: "req_1" },
      receipt_expired: { kind: "receipt_expired" as const, message: "expired", requestId: "req_1" },
      scope_changed: {
        kind: "scope_changed" as const,
        message: "wider",
        scopeRevision: "rev_2",
        preview: { sessions: [], resources: [], summary: "" },
      },
      unauthorized: { kind: "unauthorized" as const, message: "denied" },
      unavailable: { kind: "unavailable" as const, message: "no owner" },
      version_update_required: { kind: "version_update_required" as const, message: "old", contractVersion: 2 },
    }[kind]
    const copy = describeRecoveryOutcome({ kind: "refused", refusal })
    expect(copy.reading).toBe(reading)
    expect(copy.stopped).toBe(false)
    expect(copy.failed).toBe(true)
  })
})

describe("rendering a reading", () => {
  test("a Stop that never reached an owner keeps the transport's words", () => {
    const copy = describeRecoveryUnreachable("socket closed")
    expect(copy.reading).toBe("unreachable")
    expect(recoveryToastText((key) => key, copy)).toEqual({
      title: "session.recovery.unreachable.title",
      description: "session.recovery.unreachable.detail socket closed",
    })
  })

  test("a reading with no owner message renders the detail alone", () => {
    const copy = describeRecoveryOutcome(outcome("terminal", "unknown", "committed"))
    expect(recoveryToastText((key) => key, copy).description).toBe("session.recovery.cleanup_unverified.detail")
  })
})

describe("when a session offers recovery", () => {
  test("a session with no command and nothing retained does not", () => {
    expect(recoveryPanelReachable({})).toBe(false)
    expect(recoveryPanelReachable({ retained: { operations: 0, failures: 0 } })).toBe(false)
  })

  test("a command still in flight does", () => {
    expect(recoveryPanelReachable({ command: {} })).toBe(true)
  })

  test("a Stop that never reached an owner does", () => {
    expect(recoveryPanelReachable({ command: { unreachable: "socket closed" } })).toBe(true)
  })

  test("a turn that stopped and was saved does not, whatever its cleanup", () => {
    expect(recoveryPanelReachable({ command: { outcome: outcome("terminal", "unknown", "committed") } })).toBe(false)
    expect(recoveryPanelReachable({ command: { outcome: outcome("terminal", "verified_clear", "committed") } })).toBe(false)
  })

  test("a turn still running, or one whose interruption was not saved, does", () => {
    expect(recoveryPanelReachable({ command: { outcome: outcome("unknown", "owned", "pending") } })).toBe(true)
    expect(recoveryPanelReachable({ command: { outcome: outcome("terminal", "unknown", "pending") } })).toBe(true)
  })

  // The reload case: the command is gone with the page, the operation is not.
  test("work the owner still holds does, with no command at all", () => {
    expect(recoveryPanelReachable({ retained: { operations: 1, failures: 0 } })).toBe(true)
    expect(recoveryPanelReachable({ retained: { operations: 0, failures: 1 } })).toBe(true)
  })

  test("a settled command does not hide work the owner is still holding", () => {
    expect(recoveryPanelReachable({
      command: { outcome: outcome("terminal", "verified_clear", "committed") },
      retained: { operations: 0, failures: 2 },
    })).toBe(true)
  })
})

describe("which retained operations still need a person", () => {
  const op = (state: RecoveryOperation["state"], facts: RecoveryOperation["facts"]) => ({ state, facts })
  const factsOf = (value: RecoveryOutcome) => (value.kind === "operation" ? value.operation.facts : undefined)!

  // A receipt is retained for minutes after a clean stop. Counting it would
  // reopen the panel on every mount over a turn nobody needs to act on.
  test("an operation that reached its own postcondition is finished business", () => {
    expect(unresolvedRecoveryOperations([
      op("succeeded", factsOf(outcome("terminal", "verified_clear", "committed"))),
    ])).toBe(0)
    expect(unresolvedRecoveryOperations([
      op("needs_action", factsOf(outcome("terminal", "verified_clear", "committed"))),
    ])).toBe(0)
  })

  test("cleanup the harness could not prove is still unfinished business", () => {
    expect(unresolvedRecoveryOperations([
      op("needs_action", factsOf(outcome("terminal", "unknown", "committed"))),
    ])).toBe(1)
  })

  test("an unsaved interruption and a running turn both count", () => {
    expect(unresolvedRecoveryOperations([
      op("needs_action", factsOf(outcome("terminal", "verified_clear", "pending"))),
      op("needs_action", factsOf(outcome("running", "verified_clear", "committed"))),
    ])).toBe(2)
  })

  // A timed-out attempt keeps its state while later evidence corrects its
  // facts, so this shape is reachable. The facts are what a person would act
  // on, and they say the turn is over and everything it held is gone.
  test("an attempt that failed before the evidence came back clean leaves nothing to act on", () => {
    expect(unresolvedRecoveryOperations([
      op("failed", factsOf(outcome("terminal", "verified_clear", "committed"))),
    ])).toBe(0)
  })

  test("an attempt that failed with its cleanup still unproven counts", () => {
    expect(unresolvedRecoveryOperations([
      op("failed", factsOf(outcome("terminal", "owned", "committed"))),
    ])).toBe(1)
  })

  test("no operations is nothing to act on", () => {
    expect(unresolvedRecoveryOperations([])).toBe(0)
  })
})
