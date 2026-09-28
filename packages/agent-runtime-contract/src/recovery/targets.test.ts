import { target, sessionTarget, machineTarget, harnessTarget } from "./fixtures.test"
import { parseRecoveryTarget, recoveryTargetsMatch, type RecoveryTarget } from "./targets"
import { describe, test, expect } from "bun:test"

describe("target identity comparison", () => {
  test("a renewed write authority is still the same target", () => {
    expect(recoveryTargetsMatch(target, { ...target, writeAuthority: "lease-43" })).toBe(true)
    expect(recoveryTargetsMatch(target, { ...target, writeAuthority: undefined })).toBe(true)
  })

  test.each([
    ["owner generation", { ...target, ownerGeneration: "gen-4" }],
    ["turn", { ...target, turnId: "turn-8" }],
    ["session", { ...target, sessionId: "session-2" }],
    ["workspace", { ...target, workspaceId: "workspace-2" }],
    ["machine", { ...target, machineId: "machine-2" }],
    ["absent machine", { ...target, machineId: undefined }],
  ] as Array<[string, RecoveryTarget]>)("a different %s is a different target", (_label, other) => {
    expect(recoveryTargetsMatch(target, other)).toBe(false)
  })

  test("targets of different scopes never match", () => {
    expect(recoveryTargetsMatch(target, sessionTarget)).toBe(false)
    expect(recoveryTargetsMatch(sessionTarget, machineTarget)).toBe(false)
    expect(recoveryTargetsMatch(harnessTarget, machineTarget)).toBe(false)
  })

  test("each scope matches itself", () => {
    for (const value of [target, sessionTarget, harnessTarget, machineTarget] as RecoveryTarget[]) {
      expect(recoveryTargetsMatch(value, JSON.parse(JSON.stringify(value)))).toBe(true)
    }
  })

  test("a target keeps only the identity fields its scope defines", () => {
    expect(parseRecoveryTarget({ ...target, machineId: undefined, writeAuthority: undefined, pid: 4242 })).toEqual({
      scope: "turn",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-7",
      ownerGeneration: "gen-3",
    })
    expect(parseRecoveryTarget({ ...machineTarget, workspaceId: "workspace-1", turnId: "turn-7" })).toEqual(machineTarget)
    expect(parseRecoveryTarget({ ...harnessTarget, sessionId: "session-1" })).toEqual(harnessTarget)
  })
})
