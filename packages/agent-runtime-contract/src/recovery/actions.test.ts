import { type RecoveryAction, RECOVERY_ACTION_SCOPES, RECOVERY_ACTIONS } from "./actions"
import { sessionTarget, machineTarget, harnessTarget, target, codeOf, request } from "./fixtures.test"
import { parseRecoveryRequest, releasedDrainOperationId } from "./requests"
import { type RecoveryTarget, RECOVERY_TARGET_SCOPES } from "./targets"
import { RecoveryContractError } from "./validation"
import { describe, test, expect } from "bun:test"

describe("action and target scope", () => {
  test.each([
    ["cancel_turn", sessionTarget],
    ["cancel_turn", machineTarget],
    ["reconcile_session", harnessTarget],
    ["retire_harness", target],
    ["drain_daemon", target],
    ["stop_daemon", sessionTarget],
  ] as Array<[RecoveryAction, RecoveryTarget]>)("%s refuses a %o target", (action, value) => {
    expect(codeOf(() => parseRecoveryRequest({ ...request, action, target: value }))).toBe("scope_mismatch")
  })

  test.each([
    ["cancel_turn", target],
    ["reconcile_session", sessionTarget],
    ["reconcile_session", target],
    ["retire_harness", harnessTarget],
    ["drain_daemon", machineTarget],
    ["stop_daemon", machineTarget],
  ] as Array<[RecoveryAction, RecoveryTarget]>)("%s accepts its own owner", (action, value) => {
    expect(parseRecoveryRequest({ ...request, action, target: value }).target).toEqual(value)
  })

  test("inspect reaches every owner", () => {
    for (const value of [target, sessionTarget, harnessTarget, machineTarget]) {
      expect(parseRecoveryRequest({ ...request, action: "inspect", target: value }).target).toEqual(value)
    }
    expect(RECOVERY_ACTION_SCOPES.inspect).toEqual(RECOVERY_TARGET_SCOPES)
  })

  test("every action names at least one scope it can target", () => {
    for (const action of RECOVERY_ACTIONS) expect(RECOVERY_ACTION_SCOPES[action].length).toBeGreaterThan(0)
  })

  test("releasing a drain is a machine action that names the drain it reopens", () => {
    expect(RECOVERY_ACTION_SCOPES.release_drain).toEqual(["machine"])
    for (const scope of ["turn", "session", "harness"] as const) {
      expect(
        () => parseRecoveryRequest({ ...request, action: "release_drain", target: { ...target, scope } }),
        scope,
      ).toThrow(RecoveryContractError)
    }

    const release = parseRecoveryRequest({
      ...request,
      action: "release_drain",
      target: machineTarget,
      linkedOperationId: "op-drain",
    })
    expect(releasedDrainOperationId(release)).toBe("op-drain")
    // A release that names no drain names no gates either, so an owner can
    // refuse it before deciding anything about the machine.
    expect(releasedDrainOperationId({ ...release, linkedOperationId: undefined })).toBeUndefined()
    expect(releasedDrainOperationId({ ...release, action: "drain_daemon" })).toBeUndefined()
  })
})
