import { type ExecutionFact, type CleanupFact, type PersistenceFact, type RecoveryFacts } from "./facts"
import { type RecoveryError, type RecoveryOperation } from "./operations"
import { type RecoveryRequest } from "./requests"
import {
  type RecoveryTurnTarget,
  type RecoverySessionTarget,
  type RecoveryHarnessTarget,
  type RecoveryMachineTarget,
} from "./targets"
import { RecoveryContractError } from "./validation"

export const target: RecoveryTurnTarget = {
  scope: "turn",
  machineId: "machine-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-7",
  ownerGeneration: "gen-3",
  writeAuthority: "lease-42",
}

export const sessionTarget: RecoverySessionTarget = {
  scope: "session",
  machineId: "machine-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  ownerGeneration: "gen-3",
}

export const harnessTarget: RecoveryHarnessTarget = {
  scope: "harness",
  workspaceId: "workspace-1",
  harnessKey: "codex@gen-3",
  ownerGeneration: "gen-3",
}

export const machineTarget: RecoveryMachineTarget = {
  scope: "machine",
  machineId: "machine-1",
  ownerGeneration: "gen-3",
}

export const request: RecoveryRequest = {
  requestId: "req-1",
  action: "cancel_turn",
  target,
  scopeRevision: "scope-9",
  attempt: 1,
}

export function facts(execution: ExecutionFact, cleanup: CleanupFact, persistence: PersistenceFact): RecoveryFacts {
  return {
    execution: { value: execution, source: "harness", observedAt: 1_700_000_000_000, generation: "gen-3" },
    cleanup: { value: cleanup, source: "process-owner", observedAt: 1_700_000_000_100, generation: "gen-3" },
    persistence: { value: persistence, source: "runtime-store", observedAt: 1_700_000_000_200, generation: "gen-3" },
  }
}

export const cleanupError: RecoveryError = {
  code: "exit_unverified",
  origin: "workspace-host",
  target,
  stage: "kill_verify",
  executionMayContinue: true,
  message: "owned process group did not report an exit",
  at: 1_700_000_000_050,
}

export const operation: RecoveryOperation = {
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

export function codeOf(run: () => unknown): string {
  try {
    run()
    return "no_throw"
  } catch (error) {
    if (error instanceof RecoveryContractError) return error.code
    throw error
  }
}
