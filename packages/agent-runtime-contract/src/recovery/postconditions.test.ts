import { type RecoveryAction, RECOVERY_ACTIONS } from "./actions"
import { type RecoveryFacts } from "./facts"
import { facts, operation } from "./fixtures.test"
import { type RecoveryOutcome, type RecoveryRefusal } from "./outcomes"
import { recoveryPostconditionHolds, turnStopped } from "./postconditions"
import { describe, test, expect } from "bun:test"

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

describe("reading whether the turn stopped", () => {
  test.each([
    [facts("terminal", "verified_clear", "committed"), true],
    [facts("terminal", "unknown", "committed"), true],
    [facts("terminal", "owned", "committed"), true],
    [facts("terminal", "verified_clear", "pending"), false],
    [facts("terminal", "verified_clear", "unavailable"), false],
    [facts("running", "verified_clear", "committed"), false],
    [facts("unknown", "verified_clear", "committed"), false],
    [facts("running", "owned", "pending"), false],
  ] as Array<[RecoveryFacts, boolean]>)("%o stopped: %p", (value, stopped) => {
    expect(turnStopped({ kind: "operation", operation: { ...operation, facts: value } })).toBe(stopped)
  })

  test("a cancellation that cannot prove cleanup still stopped the turn", () => {
    const unproven: RecoveryOutcome = {
      kind: "operation",
      operation: { ...operation, state: "needs_action", facts: facts("terminal", "unknown", "committed") },
    }
    expect(recoveryPostconditionHolds("cancel_turn", unproven.kind === "operation" ? unproven.operation.facts : facts("unknown", "unknown", "unavailable"))).toBe(false)
    expect(turnStopped(unproven)).toBe(true)
  })

  // Keyed by the refusal kind so a kind added to the contract fails to compile
  // here rather than silently going unchecked.
  const everyRefusal: Record<RecoveryRefusal["kind"], RecoveryRefusal> = {
    generation_conflict: { kind: "generation_conflict", message: "turn-7 was replaced" },
    intent_conflict: { kind: "intent_conflict", message: "request id reused", requestId: "req-1" },
    receipt_expired: { kind: "receipt_expired", message: "no longer retained", requestId: "req-1" },
    scope_changed: {
      kind: "scope_changed",
      message: "two more sessions share this harness",
      scopeRevision: "scope-10",
      preview: { sessions: ["session-1"], resources: ["harness:codex@gen-3"], summary: "1 session, 1 harness" },
    },
    unauthorized: { kind: "unauthorized", message: "not authorized" },
    unavailable: { kind: "unavailable", message: "the owner cannot be reached" },
    version_update_required: { kind: "version_update_required", message: "client is older", contractVersion: 2 },
  }

  test("a refusal carries no facts, so it never reads as stopped", () => {
    for (const refusal of Object.values(everyRefusal)) {
      expect(turnStopped({ kind: "refused", refusal })).toBe(false)
    }
  })

  test("reopening a gate promises nothing about the machine it reopens", () => {
    expect(recoveryPostconditionHolds("release_drain", facts("running", "owned", "unavailable"))).toBe(true)
  })
})
