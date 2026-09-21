import { randomUUID } from "node:crypto"
import {
  capChildBudget,
  finalizeRecoveryOperation,
  normalizeRecoveryTarget,
  type RecoveryAction,
  type RecoveryBudgets,
  type RecoveryError,
  type RecoveryFacts,
  type RecoveryGeneration,
  type RecoveryOperation,
  type RecoveryRequest,
  type RecoverySessionTarget,
  type RecoveryTarget,
  RECOVERY_OPERATION_RETENTION_MS,
} from "@claxedo/agent-runtime-contract"
import { recoveryScopeKey, recoveryTargetSessionId } from "../harnesses/shared/runtime-store"
import type { AgentRuntimeStore, RecoveryCaller } from "./contracts"
import { messageOf, type RecoveryFactsOwner } from "./recovery-facts"

/** The session an operation is listed under, for the scopes that name one. */
export const sessionIdOf = (target: RecoveryTarget) => recoveryTargetSessionId(target) ?? undefined

/** Which target scopes a caller's authority reaches. */
export function mayAct(caller: RecoveryCaller, target: RecoveryTarget) {
  if (target.scope === "machine") return caller.authority === "machine"
  if (target.scope === "harness") return caller.authority !== "session"
  return true
}

export type TrackedOperation = {
  operation: RecoveryOperation
  request: RecoveryRequest
  callers: Set<string>
  sessionId?: string
  deadlineAt: number
  /**
   * The attempt is over: it reached a terminal state or ran out of deadline.
   * Evidence arriving afterwards corrects the facts and never the state, so a
   * cancellation that timed out is not rewritten into one that worked.
   */
  closed: boolean
  closedAt?: number
}


/**
 * A tombstone only has to outlive the callers that might redeliver a request
 * whose operation has already expired, and each one is a single id. Dropping
 * the oldest bounds them without a sweep of their own.
 */
const RECOVERY_TOMBSTONE_LIMIT = 1024



export type RecoveryOperationsInput = {
  store: AgentRuntimeStore
  facts: RecoveryFactsOwner
  budgets: RecoveryBudgets
  owner: RecoveryGeneration
  machineId?: string
  sessionTarget: (sessionId: string, ownerGeneration: RecoveryGeneration) => RecoverySessionTarget
  now: () => number
}

/**
 * The registry of recovery operations: the receipt a request id claims, the
 * one in-flight attempt per target generation that later callers join, and how
 * long a settled attempt stays readable.
 */
export function createRecoveryOperations(input: RecoveryOperationsInput) {
  const { store, facts: record, budgets, owner, sessionTarget, now } = input
  const operations = new Map<string, TrackedOperation>()
  const byRequest = new Map<string, string>()
  const inFlight = new Map<string, string>()
  const expiredRequests = new Set<string>()
  const expiredOperations = new Set<string>()

  const requestKey = (target: RecoveryTarget, callerId: string, requestId: string) =>
    `${recoveryScopeKey(target)}\u0000${callerId}\u0000${requestId}`

  /**
   * The identity `recoveryTargetsMatch` compares, so two callers naming one
   * turn meet on it. `writeAuthority` is excluded there because a lease may be
   * renewed for the very turn being named, and including it here would open a
   * second controller over that turn.
   */
  const coalesceKey = (target: RecoveryTarget, action: RecoveryAction) => {
    const identity = normalizeRecoveryTarget(target)
    const keyed = identity.scope === "turn"
      ? {
        scope: identity.scope,
        ...(identity.machineId !== undefined ? { machineId: identity.machineId } : {}),
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        ownerGeneration: identity.ownerGeneration,
      }
      : identity
    return `${JSON.stringify(keyed)}\u0000${action}`
  }

  /** The request an already-recorded operation was created from. */
  const intentOf = (operation: RecoveryOperation): RecoveryRequest => ({
    requestId: operation.requestId,
    action: operation.action,
    target: operation.target,
    scopeRevision: operation.scopeRevision,
    attempt: operation.attempt,
    ...(operation.linkedOperationId !== undefined ? { linkedOperationId: operation.linkedOperationId } : {}),
  })

  const expire = (key: string, set: Set<string>) => {
    set.add(key)
    if (set.size <= RECOVERY_TOMBSTONE_LIMIT) return
    const oldest = set.values().next()
    if (!oldest.done) set.delete(oldest.value)
  }

  const sweep = () => {
    const horizon = now() - RECOVERY_OPERATION_RETENTION_MS
    for (const [operationId, tracked] of operations) {
      if (!tracked.closed || (tracked.closedAt ?? now()) > horizon) continue
      operations.delete(operationId)
      expire(operationId, expiredOperations)
      for (const callerId of tracked.callers) {
        const key = requestKey(tracked.operation.target, callerId, tracked.operation.requestId)
        byRequest.delete(key)
        expire(key, expiredRequests)
      }
    }
  }

  const volatileReceipt = (tracked: TrackedOperation, error: unknown) => {
    tracked.operation = { ...tracked.operation, receipt: "volatile" }
    record.retainOwnerFailure(record.recoveryError(
      "persistence_unavailable",
      tracked.operation.target,
      tracked.operation.phase,
      false,
      `Recovery operation ${tracked.operation.operationId} has no durable receipt: ${messageOf(error)}`,
    ))
  }

  /**
   * Claim the durable receipt. The store holds the uniqueness constraint that
   * spans instances, so a request id it has already accepted returns the
   * operation that owns it rather than a second one issuing the same effect.
   */
  const claimReceipt = (tracked: TrackedOperation, callerId: string): RecoveryOperation | undefined => {
    try {
      const recorded = store.recordRecoveryOperation(tracked.operation, { callerId })
      return recorded.created ? undefined : recorded.existing
    } catch (error) {
      volatileReceipt(tracked, error)
      return undefined
    }
  }

  const update = (tracked: TrackedOperation, next: Partial<RecoveryOperation>, callerId: string) => {
    tracked.operation = { ...tracked.operation, ...next, updatedAt: now() }
    try {
      store.updateRecoveryOperation(tracked.operation)
    } catch (error) {
      volatileReceipt(tracked, error)
    }
    return tracked.operation
  }

  const close = (tracked: TrackedOperation, next: Partial<RecoveryOperation>, callerId: string) => {
    const operation = update(tracked, next, callerId)
    tracked.closed = true
    tracked.closedAt = now()
    inFlight.delete(coalesceKey(operation.target, operation.action))
    return operation
  }

  /**
   * Evidence that arrived after the attempt closed. It corrects what the owner
   * believes about the target; it never revises the attempt's own verdict.
   */
  const recordLateEvidence = (operationId: string, facts: RecoveryFacts) => {
    const tracked = operations.get(operationId)
    if (!tracked) return
    update(tracked, tracked.closed
      ? { facts }
      : finalizeRecoveryOperation(tracked.operation, facts), [...tracked.callers][0] ?? "")
  }


  const operationBudget = (action: RecoveryAction) => {
    if (action === "cancel_turn") return budgets.gracefulCancelMs
    if (action === "reconcile_session") return budgets.reconcileMs
    return budgets.ackMs
  }

  const create = (request: RecoveryRequest, callerId: string): TrackedOperation => {
    const startedAt = now()
    const deadlineAt = startedAt + operationBudget(request.action)
    const sessionId = sessionIdOf(request.target)
    const operation: RecoveryOperation = {
      operationId: `rop_${randomUUID()}`,
      requestId: request.requestId,
      target: normalizeRecoveryTarget(request.target),
      action: request.action,
      scopeRevision: request.scopeRevision,
      attempt: request.attempt,
      state: "accepted",
      phase: "ack",
      phaseDeadlineAt: capChildBudget(deadlineAt, budgets.ackMs, startedAt),
      facts: sessionId ? record.sessionFacts(sessionId) : record.unknownFacts(),
      cleanupErrors: [],
      nextActions: [],
      receipt: "durable",
      ...(request.linkedOperationId !== undefined ? { linkedOperationId: request.linkedOperationId } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    }
    const tracked: TrackedOperation = {
      operation,
      request,
      callers: new Set([callerId]),
      ...(sessionId !== undefined ? { sessionId } : {}),
      deadlineAt,
      closed: false,
    }
    operations.set(operation.operationId, tracked)
    byRequest.set(requestKey(request.target, callerId, request.requestId), operation.operationId)
    inFlight.set(coalesceKey(request.target, request.action), operation.operationId)
    return tracked
  }


  /** The receipt a joining caller reads its operation back by, after a restart. */
  const joinReceipt = (tracked: TrackedOperation, callerId: string) => {
    try {
      store.addRecoveryOperationCaller(tracked.operation.operationId, { callerId })
    } catch (error) {
      volatileReceipt(tracked, error)
    }
  }


  const readStoredOperation = (operationId: string, caller: RecoveryCaller) => {
    try {
      return store.readRecoveryOperation(operationId, { callerId: caller.callerId })
    } catch (error) {
      record.retainOwnerFailure(record.recoveryError(
        "persistence_unavailable",
        { scope: "machine", machineId: input.machineId ?? "local", ownerGeneration: owner },
        "reconcile",
        false,
        `Stored recovery operation ${operationId} is unreadable: ${messageOf(error)}`,
      ))
      return undefined
    }
  }


  /**
   * Operations this owner did not record: another instance's, or its own from
   * before a restart. An unreadable store is reported to the caller rather than
   * thrown, because inspection is what a caller falls back to.
   */
  const storedOperations = (sessionId: string, problems: RecoveryError[]) => {
    try {
      return store.listRecoveryOperations({ sessionId })
    } catch (error) {
      problems.push(record.recoveryError(
        "persistence_unavailable",
        sessionTarget(sessionId, owner),
        "reconcile",
        false,
        `Stored recovery operations for session ${sessionId} are unreadable: ${messageOf(error)}`,
      ))
      return []
    }
  }


  const operationsFor = (sessionId: string, problems: RecoveryError[]) => {
    const live = [...operations.values()]
      .filter((tracked) => tracked.sessionId === sessionId)
      .map((tracked) => tracked.operation)
    const held = new Set(live.map((operation) => operation.operationId))
    return [...live, ...storedOperations(sessionId, problems).filter((row) => !held.has(row.operationId))]
  }


  return {
    sweep,
    requestKey,
    create,
    claimReceipt,
    joinReceipt,
    update,
    close,
    recordLateEvidence,
    intentOf,
    readStoredOperation,
    operationsFor,
    byId: (operationId: string) => operations.get(operationId),
    expiredRequest: (key: string) => expiredRequests.has(key),
    expiredOperation: (operationId: string) => expiredOperations.has(operationId),
    /** The operation this caller's request id already claimed, if it claimed one. */
    trackedFor: (key: string) => {
      const held = byRequest.get(key)
      return held === undefined ? undefined : operations.get(held)
    },
    /** The attempt a later caller joins rather than opening a second controller. */
    joinable: (target: RecoveryTarget, action: RecoveryAction) => {
      const held = inFlight.get(coalesceKey(target, action))
      const tracked = held === undefined ? undefined : operations.get(held)
      return tracked && !tracked.closed ? tracked : undefined
    },
    register: (key: string, operationId: string) => { byRequest.set(key, operationId) },
    forget: (key: string) => { byRequest.delete(key) },
    /** Drop an operation this owner minted but must not run. */
    discard: (tracked: TrackedOperation, target: RecoveryTarget, action: RecoveryAction) => {
      operations.delete(tracked.operation.operationId)
      inFlight.delete(coalesceKey(target, action))
    },
    adopt: (claimed: RecoveryOperation, request: RecoveryRequest, callerId: string) => {
      const sessionId = recoveryTargetSessionId(claimed.target)
      operations.set(claimed.operationId, {
        operation: claimed,
        request,
        callers: new Set([callerId]),
        ...(sessionId !== null ? { sessionId } : {}),
        deadlineAt: claimed.phaseDeadlineAt,
        closed: true,
        closedAt: now(),
      })
    },
  }
}

export type RecoveryOperations = ReturnType<typeof createRecoveryOperations>
