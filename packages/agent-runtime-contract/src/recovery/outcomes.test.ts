import { type RecoveryAction } from "./actions"
import {
  target,
  machineTarget,
  operation,
  sessionTarget,
  harnessTarget,
  cleanupError,
  codeOf,
} from "./fixtures.test"
import {
  type RecoveryRefusal,
  type RecoveryOutcome,
  serializeRecoveryOutcome,
  parseRecoveryOutcome,
  isRecoveryOutcome,
} from "./outcomes"
import { type RecoveryTargetScope, type RecoveryTarget } from "./targets"
import { describe, test, expect } from "bun:test"

describe("outcome wire form", () => {
  const refusals: RecoveryRefusal[] = [
    { kind: "generation_conflict", message: "turn-7 was replaced", current: { ...target, turnId: "turn-8", ownerGeneration: "gen-4" } },
    { kind: "generation_conflict", message: "the current turn is not visible to this caller" },
    { kind: "intent_conflict", message: "request id reused with a different target", requestId: "req-1" },
    { kind: "receipt_expired", message: "the receipt for req-1 is no longer retained", requestId: "req-1" },
    { kind: "scope_changed", message: "two more sessions now share this harness", scopeRevision: "scope-10", preview: { sessions: ["session-1", "session-2"], resources: ["harness:codex@gen-3"], summary: "2 sessions, 1 harness" } },
    { kind: "generation_conflict", message: "the daemon was replaced", current: machineTarget },
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

  test.each([
    ["turn", "cancel_turn", target],
    ["session", "reconcile_session", sessionTarget],
    ["harness", "retire_harness", harnessTarget],
    ["machine", "drain_daemon", machineTarget],
  ] as Array<[RecoveryTargetScope, RecoveryAction, RecoveryTarget]>)("round trips a %s-scoped operation", (_scope, action, value) => {
    const outcome: RecoveryOutcome = {
      kind: "operation",
      operation: { ...operation, action, target: value, initiatingError: { ...cleanupError, target: value }, cleanupErrors: [{ ...cleanupError, target: value }] },
    }
    const once = serializeRecoveryOutcome(parseRecoveryOutcome(serializeRecoveryOutcome(outcome)))
    expect(parseRecoveryOutcome(once)).toEqual(outcome)
    expect(serializeRecoveryOutcome(parseRecoveryOutcome(once))).toBe(once)
  })

  test.each([
    ["cancel_turn", machineTarget],
    ["retire_harness", target],
    ["drain_daemon", sessionTarget],
    ["reconcile_session", harnessTarget],
  ] as Array<[RecoveryAction, RecoveryTarget]>)("refuses a published %s operation against a %o target", (action, value) => {
    const broken = { kind: "operation", operation: { ...operation, action, target: value } }
    expect(codeOf(() => parseRecoveryOutcome(broken))).toBe("scope_mismatch")
    expect(isRecoveryOutcome(broken)).toBe(false)
  })

  test("a decoded value is accepted as well as the transport's text", () => {
    const outcome: RecoveryOutcome = { kind: "operation", operation }
    expect(parseRecoveryOutcome(JSON.parse(serializeRecoveryOutcome(outcome)))).toEqual(outcome)
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
