import { type RecoveryAction, RECOVERY_ACTIONS, isMutatingRecoveryAction } from "./actions"
import { request, target, harnessTarget, codeOf, sessionTarget } from "./fixtures.test"
import { parseRecoveryRequest, recoveryIntentEquals, normalizeRecoveryIntent } from "./requests"
import { describe, test, expect } from "bun:test"

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
    ["target without a scope", { ...request, target: { ...target, scope: undefined } }, "invalid_target_scope"],
    ["target with an unknown scope", { ...request, target: { ...target, scope: "cluster" } }, "invalid_target_scope"],
    ["machine target without a machine", { ...request, action: "drain_daemon", target: { scope: "machine", ownerGeneration: "gen-3" } }, "invalid_target"],
    ["harness target without a key", { ...request, action: "retire_harness", target: { ...harnessTarget, harnessKey: "" } }, "invalid_target"],
    ["request not an object", "cancel", "invalid_payload"],
    ["empty linked operation", { ...request, linkedOperationId: "" }, "invalid_operation"],
  ])("rejects %s", (_label, input, code) => {
    expect(codeOf(() => parseRecoveryRequest(input))).toBe(code)
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
    ["target scope", { action: "reconcile_session" as RecoveryAction, target: sessionTarget }],
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
