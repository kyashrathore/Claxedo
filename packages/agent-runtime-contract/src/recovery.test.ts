import { describe, expect, test } from "bun:test"
import {
  capChildBudget,
  DEFAULT_RECOVERY_BUDGETS,
  finalizeRecoveryOperation,
  isRecoveryOutcome,
  isMutatingRecoveryAction,
  normalizeRecoveryIntent,
  parseRecoveryOutcome,
  parseRecoveryRequest,
  parseRecoveryTarget,
  RECOVERY_ACTIONS,
  RecoveryContractError,
  recoveryIntentEquals,
  recoveryPostconditionHolds,
  serializeRecoveryOutcome,
  type CleanupFact,
  type ExecutionFact,
  type PersistenceFact,
  type RecoveryAction,
  type RecoveryError,
  type RecoveryFacts,
  type RecoveryOperation,
  type RecoveryOutcome,
  type RecoveryRefusal,
  type RecoveryRequest,
  type RecoveryTarget,
} from "./recovery"

const target: RecoveryTarget = {
  machineId: "machine-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-7",
  ownerGeneration: "gen-3",
  writeAuthority: "lease-42",
}

const request: RecoveryRequest = {
  requestId: "req-1",
  action: "cancel_turn",
  target,
  scopeRevision: "scope-9",
  attempt: 1,
}

function facts(execution: ExecutionFact, cleanup: CleanupFact, persistence: PersistenceFact): RecoveryFacts {
  return {
    execution: { value: execution, source: "harness", observedAt: 1_700_000_000_000, generation: "gen-3" },
    cleanup: { value: cleanup, source: "process-owner", observedAt: 1_700_000_000_100, generation: "gen-3" },
    persistence: { value: persistence, source: "runtime-store", observedAt: 1_700_000_000_200, generation: "gen-3" },
  }
}

const cleanupError: RecoveryError = {
  code: "exit_unverified",
  origin: "workspace-host",
  target,
  stage: "kill_verify",
  executionMayContinue: true,
  message: "owned process group did not report an exit",
  at: 1_700_000_000_050,
}

const operation: RecoveryOperation = {
  operationId: "op-1",
  requestId: request.requestId,
  target,
  action: "cancel_turn",
  scopeRevision: request.scopeRevision,
  attempt: 2,
  state: "needs_action",
  phase: "kill_verify",
  phaseDeadlineAt: 1_700_000_002_000,
  facts: facts("terminal", "unknown", "committed"),
  initiatingError: { ...cleanupError, code: "cancellation_timeout", stage: "graceful_cancel" },
  cleanupErrors: [cleanupError],
  nextActions: [{ action: "retire_harness", scopePreviewRequired: true, reason: "owned resources unverified" }],
  receipt: "volatile",
  linkedOperationId: "op-0",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_300,
}

function codeOf(run: () => unknown): string {
  try {
    run()
    return "no_throw"
  } catch (error) {
    if (error instanceof RecoveryContractError) return error.code
    throw error
  }
}

describe("recovery request validation", () => {
  test("accepts a complete request unchanged", () => {
    expect(parseRecoveryRequest(JSON.parse(JSON.stringify(request)))).toEqual(request)
  })

  test.each([
    ["missing generation", { ...request, target: { ...target, ownerGeneration: "" } }, "missing_generation"],
    ["absent generation", { ...request, target: { ...target, ownerGeneration: undefined } }, "missing_generation"],
    ["unknown action", { ...request, action: "restart_everything" }, "invalid_action"],
    ["empty request id", { ...request, requestId: "" }, "invalid_request_id"],
    ["attempt below one", { ...request, attempt: 0 }, "invalid_attempt"],
    ["fractional attempt", { ...request, attempt: 1.5 }, "invalid_attempt"],
    ["empty scope revision", { ...request, scopeRevision: "" }, "invalid_scope_revision"],
    ["missing turn", { ...request, target: { ...target, turnId: undefined } }, "invalid_target"],
    ["missing session", { ...request, target: { ...target, sessionId: "" } }, "invalid_target"],
    ["missing workspace", { ...request, target: { ...target, workspaceId: undefined } }, "invalid_target"],
    ["target not an object", { ...request, target: "turn-7" }, "invalid_target"],
    ["request not an object", "cancel", "invalid_payload"],
    ["empty linked operation", { ...request, linkedOperationId: "" }, "invalid_operation"],
  ])("rejects %s", (_label, input, code) => {
    expect(codeOf(() => parseRecoveryRequest(input))).toBe(code)
  })

  test("a target keeps only the identity fields it was given", () => {
    expect(parseRecoveryTarget({ ...target, machineId: undefined, writeAuthority: undefined, pid: 4242 })).toEqual({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-7",
      ownerGeneration: "gen-3",
    })
  })
})

describe("repeated request identity", () => {
  test("the same intent under a different request id and attempt is the same command", () => {
    expect(recoveryIntentEquals(request, { ...request, requestId: "req-2", attempt: 4 })).toBe(true)
  })

  test.each([
    ["action", { action: "reconcile_session" as RecoveryAction }],
    ["owner generation", { target: { ...target, ownerGeneration: "gen-4" } }],
    ["turn", { target: { ...target, turnId: "turn-8" } }],
    ["scope revision", { scopeRevision: "scope-10" }],
    ["linked operation", { linkedOperationId: "op-9" }],
  ])("the same request id with a different %s is a different command", (_label, change) => {
    expect(recoveryIntentEquals(request, { ...request, ...change })).toBe(false)
  })

  test("the normalized intent carries neither the request id nor the attempt", () => {
    expect(Object.keys(normalizeRecoveryIntent(request))).toEqual(["action", "scopeRevision", "target"])
  })

  test("only inspect is a read among the operation actions", () => {
    expect(RECOVERY_ACTIONS.filter((action) => !isMutatingRecoveryAction(action))).toEqual(["inspect"])
  })
})

describe("phase budgets", () => {
  test("a child phase never runs past its parent deadline", () => {
    const parentDeadlineAt = 1_000 + DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs
    expect(capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.providerQueryMs, 1_000)).toBe(6_000)
    expect(capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.reconcileMs, 1_000)).toBe(parentDeadlineAt)
  })

  test("sequential child phases do not multiply the parent deadline", () => {
    const parentDeadlineAt = 1_000 + DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs
    const first = capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.termGraceMs, 1_000)
    const second = capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.killVerifyMs, first)
    const third = capChildBudget(parentDeadlineAt, DEFAULT_RECOVERY_BUDGETS.drainMs, second)
    expect(third).toBe(parentDeadlineAt)
  })

  test("an expired parent leaves no time at all", () => {
    expect(capChildBudget(900, DEFAULT_RECOVERY_BUDGETS.ackMs, 1_000)).toBe(1_000)
  })

  test.each([
    [Number.NaN, 1_000, 0],
    [1_000, Number.POSITIVE_INFINITY, 0],
    [1_000, 100, Number.NaN],
    [1_000, -1, 0],
  ])("rejects a non-finite or negative budget (%p, %p, %p)", (parentDeadlineAt, childMs, now) => {
    expect(codeOf(() => capChildBudget(parentDeadlineAt, childMs, now))).toBe("invalid_budget")
  })
})

describe("advertised postconditions", () => {
  test.each([
    ["inspect", facts("running", "owned", "unavailable"), true],
    ["cancel_turn", facts("terminal", "verified_clear", "committed"), true],
    ["cancel_turn", facts("terminal", "owned", "committed"), false],
    ["cancel_turn", facts("unknown", "verified_clear", "committed"), false],
    ["cancel_turn", facts("terminal", "verified_clear", "pending"), false],
    ["reconcile_session", facts("running", "owned", "committed"), true],
    ["reconcile_session", facts("terminal", "verified_clear", "unavailable"), false],
    ["retire_harness", facts("terminal", "verified_clear", "committed"), true],
    ["retire_harness", facts("terminal", "unknown", "committed"), false],
    ["drain_daemon", facts("terminal", "verified_clear", "committed"), true],
    ["drain_daemon", facts("running", "verified_clear", "committed"), false],
    ["stop_daemon", facts("terminal", "verified_clear", "unavailable"), true],
    ["stop_daemon", facts("unknown", "verified_clear", "committed"), false],
  ] as Array<[RecoveryAction, RecoveryFacts, boolean]>)("%s over %o holds: %p", (action, value, holds) => {
    expect(recoveryPostconditionHolds(action, value)).toBe(holds)
  })

  test("every action has a postcondition entry", () => {
    for (const action of RECOVERY_ACTIONS) {
      expect(typeof recoveryPostconditionHolds(action, facts("unknown", "unknown", "unavailable"))).toBe("boolean")
    }
  })
})

describe("finalizing an attempt", () => {
  test("unknown execution cannot finish a cancellation", () => {
    const finalized = finalizeRecoveryOperation(
      { ...operation, initiatingError: undefined, cleanupErrors: [] },
      facts("unknown", "verified_clear", "committed"),
    )
    expect(finalized.state).toBe("needs_action")
  })

  test("a known failure alongside an unmet postcondition is failed, not pending", () => {
    expect(finalizeRecoveryOperation(operation, facts("terminal", "unknown", "committed")).state).toBe("failed")
  })

  test("a met postcondition succeeds and carries the newest observation time", () => {
    const finalized = finalizeRecoveryOperation(operation, facts("terminal", "verified_clear", "committed"))
    expect(finalized.state).toBe("succeeded")
    expect(finalized.updatedAt).toBe(1_700_000_000_300)
  })

  test("later evidence updates the facts of a terminal attempt without rewriting it", () => {
    const failed = { ...operation, state: "failed" as const }
    const finalized = finalizeRecoveryOperation(failed, facts("terminal", "verified_clear", "committed"))
    expect(finalized.state).toBe("failed")
    expect(finalized.facts.cleanup.value).toBe("verified_clear")
  })
})

describe("outcome wire form", () => {
  const refusals: RecoveryRefusal[] = [
    { kind: "generation_conflict", message: "turn-7 was replaced", current: { ...target, turnId: "turn-8", ownerGeneration: "gen-4" } },
    { kind: "generation_conflict", message: "the current turn is not visible to this caller" },
    { kind: "intent_conflict", message: "request id reused with a different target", requestId: "req-1" },
    { kind: "receipt_expired", message: "the receipt for req-1 is no longer retained", requestId: "req-1" },
    { kind: "scope_changed", message: "two more sessions now share this harness", scopeRevision: "scope-10", preview: { sessions: ["session-1", "session-2"], resources: ["harness:codex@gen-3"], summary: "2 sessions, 1 harness" } },
    { kind: "unauthorized", message: "session access does not authorize retiring a shared harness" },
    { kind: "unavailable", message: "this instance does not own turn-7 and cannot reach the owner" },
    { kind: "version_update_required", message: "this client predates the recovery contract", contractVersion: 2 },
  ]

  test.each([
    ["operation", { kind: "operation", operation } as RecoveryOutcome],
    ...refusals.map((refusal) => [refusal.kind, { kind: "refused", refusal } as RecoveryOutcome] as const),
  ])("round trips a %s outcome through JSON", (_label, outcome) => {
    const once = serializeRecoveryOutcome(parseRecoveryOutcome(serializeRecoveryOutcome(outcome)))
    expect(parseRecoveryOutcome(once)).toEqual(outcome)
    expect(serializeRecoveryOutcome(parseRecoveryOutcome(once))).toBe(once)
  })

  test("a decoded value is accepted as well as the transport's text", () => {
    const outcome: RecoveryOutcome = { kind: "operation", operation }
    expect(parseRecoveryOutcome(JSON.parse(serializeRecoveryOutcome(outcome)))).toEqual(outcome)
  })

  test.each([
    ["non-finite observation time", { execution: { value: "terminal", source: "harness", observedAt: Number.POSITIVE_INFINITY, generation: "gen-3" } }, "invalid_observed_at"],
    ["unknown fact value", { execution: { value: "finished", source: "harness", observedAt: 1, generation: "gen-3" } }, "invalid_fact"],
    ["fact without a generation", { execution: { value: "terminal", source: "harness", observedAt: 1 } }, "missing_generation"],
  ])("rejects an operation with a %s", (_label, override, code) => {
    const broken = { kind: "operation", operation: { ...operation, facts: { ...operation.facts, ...override } } }
    expect(codeOf(() => parseRecoveryOutcome(broken))).toBe(code)
  })

  test.each([
    ["an unknown outcome kind", { kind: "maybe", operation }],
    ["a refusal kind nobody publishes", { kind: "refused", refusal: { kind: "try_later", message: "soon" } }],
    ["an operation state nobody publishes", { kind: "operation", operation: { ...operation, state: "pending" } }],
    ["an operation phase nobody publishes", { kind: "operation", operation: { ...operation, phase: "thinking" } }],
    ["a receipt that claims neither durability", { kind: "operation", operation: { ...operation, receipt: "maybe" } }],
    ["a scope change without its preview", { kind: "refused", refusal: { kind: "scope_changed", message: "changed", scopeRevision: "scope-10" } }],
    ["plain text", "cancelled"],
    ["nothing", undefined],
  ])("is not an outcome: %s", (_label, value) => {
    expect(isRecoveryOutcome(value)).toBe(false)
  })

  test("a complete outcome is recognized", () => {
    expect(isRecoveryOutcome(JSON.parse(serializeRecoveryOutcome({ kind: "operation", operation })))).toBe(true)
  })
})
