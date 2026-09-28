import { asRecord, asText } from "../values"
import { type RecoveryGeneration } from "./facts"
import { RecoveryContractError, member, requireRecoveryText } from "./validation"

export const RECOVERY_TARGET_SCOPES = ["turn", "session", "harness", "machine"] as const

export type RecoveryTargetScope = (typeof RECOVERY_TARGET_SCOPES)[number]

export type RecoveryTurnTarget = {
  scope: "turn"
  machineId?: string
  workspaceId: string
  sessionId: string
  turnId: string
  ownerGeneration: RecoveryGeneration
  /** The durable lease or token id whose holder may write for this target. */
  writeAuthority?: string
}

export type RecoverySessionTarget = {
  scope: "session"
  machineId?: string
  workspaceId: string
  sessionId: string
  ownerGeneration: RecoveryGeneration
}

export type RecoveryHarnessTarget = {
  scope: "harness"
  machineId?: string
  workspaceId: string
  /** The harness generation's own key; a harness may serve several sessions. */
  harnessKey: string
  ownerGeneration: RecoveryGeneration
}

export type RecoveryMachineTarget = {
  scope: "machine"
  machineId: string
  ownerGeneration: RecoveryGeneration
}

/**
 * The scopes carry different fields because they name different things: a
 * daemon has no session and a harness generation outlives any one turn.
 * Flattening them would make a caller invent a session id to drain a daemon,
 * and an invented identity is indistinguishable from a real one downstream.
 */
export type RecoveryTarget =
  | RecoveryTurnTarget
  | RecoverySessionTarget
  | RecoveryHarnessTarget
  | RecoveryMachineTarget

export function normalizeRecoveryTarget(target: RecoveryTarget): RecoveryTarget {
  if (target.scope === "machine") {
    return { scope: "machine", machineId: target.machineId, ownerGeneration: target.ownerGeneration }
  }
  const machine = target.machineId !== undefined ? { machineId: target.machineId } : {}
  if (target.scope === "harness") {
    return {
      scope: "harness",
      ...machine,
      workspaceId: target.workspaceId,
      harnessKey: target.harnessKey,
      ownerGeneration: target.ownerGeneration,
    }
  }
  if (target.scope === "session") {
    return {
      scope: "session",
      ...machine,
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      ownerGeneration: target.ownerGeneration,
    }
  }
  return {
    scope: "turn",
    ...machine,
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
    turnId: target.turnId,
    ownerGeneration: target.ownerGeneration,
    ...(target.writeAuthority !== undefined ? { writeAuthority: target.writeAuthority } : {}),
  }
}

/**
 * Whether two targets name the same resource under the same owner generation.
 * `writeAuthority` is excluded: a lease may be renewed or reissued for the very
 * turn a caller is checking, so comparing it would call a live target stale.
 */
export function recoveryTargetsMatch(a: RecoveryTarget, b: RecoveryTarget): boolean {
  return JSON.stringify(targetIdentity(a)) === JSON.stringify(targetIdentity(b))
}

function targetIdentity(target: RecoveryTarget): unknown[] {
  const machine = target.machineId ?? null
  if (target.scope === "machine") return ["machine", machine, target.ownerGeneration]
  if (target.scope === "harness") {
    return ["harness", machine, target.workspaceId, target.harnessKey, target.ownerGeneration]
  }
  if (target.scope === "session") {
    return ["session", machine, target.workspaceId, target.sessionId, target.ownerGeneration]
  }
  return ["turn", machine, target.workspaceId, target.sessionId, target.turnId, target.ownerGeneration]
}

export function parseRecoveryTarget(input: unknown): RecoveryTarget {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_target", "recovery target must be an object")
  if (!member(RECOVERY_TARGET_SCOPES, row.scope)) {
    throw new RecoveryContractError("invalid_target_scope", `unknown recovery target scope ${JSON.stringify(row.scope)}`)
  }
  const ownerGeneration = asText(row.ownerGeneration)
  if (ownerGeneration === undefined) {
    throw new RecoveryContractError("missing_generation", "recovery target ownerGeneration is required")
  }
  if (row.scope === "machine") {
    return {
      scope: "machine",
      machineId: requireRecoveryText(row.machineId, "invalid_target", "machineId"),
      ownerGeneration,
    }
  }
  const machine = row.machineId !== undefined
    ? { machineId: requireRecoveryText(row.machineId, "invalid_target", "machineId") }
    : {}
  const workspaceId = requireRecoveryText(row.workspaceId, "invalid_target", "workspaceId")
  if (row.scope === "harness") {
    return {
      scope: "harness",
      ...machine,
      workspaceId,
      harnessKey: requireRecoveryText(row.harnessKey, "invalid_target", "harnessKey"),
      ownerGeneration,
    }
  }
  const sessionId = requireRecoveryText(row.sessionId, "invalid_target", "sessionId")
  if (row.scope === "session") return { scope: "session", ...machine, workspaceId, sessionId, ownerGeneration }
  return {
    scope: "turn",
    ...machine,
    workspaceId,
    sessionId,
    turnId: requireRecoveryText(row.turnId, "invalid_target", "turnId"),
    ownerGeneration,
    ...(row.writeAuthority !== undefined ? { writeAuthority: requireRecoveryText(row.writeAuthority, "invalid_target", "writeAuthority") } : {}),
  }
}
