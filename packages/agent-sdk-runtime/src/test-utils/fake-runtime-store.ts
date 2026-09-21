import type { CompatEvent } from "../compat-events"
import { AgentRuntimeStaleTurnError, recoveryScopeKey, recoveryTargetSessionId } from "../harnesses/shared/runtime-store"
import type {
  AgentRuntimeCommittedCompatOutput,
  AgentRuntimeStoreWithRecovery,
  AgentRuntimeTurnFinishInput,
  AgentRuntimeTurnStartInput,
} from "../harnesses/shared/runtime-store"
import { MemoryRuntimeStore } from "../stores/memory"
import { RECOVERY_OPERATION_RETENTION_MS, type RecoveryOperation, type RecoveryTarget } from "@claxedo/agent-runtime-contract"

/**
 * The same key the durable stores enforce with a unique index, spelled the way
 * the memory store spells it: a fake that keyed receipts differently would
 * accept a request every real store refuses.
 */
function recoveryRequestKey(target: RecoveryTarget, callerId: string, requestId: string) {
  return `${recoveryScopeKey(target)}\u0000${callerId}\u0000${requestId}`
}

/** Creates the commit receipt used by focused store-port tests. */
export function committedAppend(input: {
  sessionId: string
  agentSessionId?: string
  payload: CompatEvent
}): AgentRuntimeCommittedCompatOutput {
  return {
    sessionId: input.sessionId,
    seq: 1,
    createdAt: 1,
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    payload: input.payload,
  }
}

/** Commits the standard opening events for a turn. */
export function committedStartTurn(input: AgentRuntimeTurnStartInput) {
  return new MemoryRuntimeStore().startTurn(input)
}

/** A complete inert store whose individual operations can be replaced by a test. */
export function fakeRuntimeStore(
  overrides: Partial<AgentRuntimeStoreWithRecovery> = {},
): AgentRuntimeStoreWithRecovery {
  const leases = new Map<string, { leaseId: string; acquiredAt: number }>()
  const operations = new Map<string, RecoveryOperation>()
  const claims = new Map<string, RecoveryOperation>()
  const callers = new Map<string, Set<string>>()
  let mintedLeases = 0
  return {
    listSessions: () => [],
    getSession: () => null,
    bindSession: () => {},
    updateSessionConfig: () => null,
    updateSession: () => null,
    getSessionConfig: () => null,
    deleteSession: () => {},
    getAgentSessionId: () => null,
    getExecutionBinding: () => null,
    startTurn: committedStartTurn,
    turnEvidence: () => ({ started: false, finished: false }),
    recordRecoveryOperation: (operation, caller) => {
      const key = recoveryRequestKey(operation.target, caller.callerId, operation.requestId)
      const claimed = claims.get(key)
      if (claimed) return { created: false, existing: operations.get(claimed.operationId) ?? claimed }
      claims.set(key, operation)
      operations.set(operation.operationId, operation)
      callers.set(operation.operationId, new Set([caller.callerId]))
      return { created: true }
    },
    addRecoveryOperationCaller: (operationId, caller) => {
      if (!operations.has(operationId)) return
      callers.set(operationId, (callers.get(operationId) ?? new Set<string>()).add(caller.callerId))
    },
    updateRecoveryOperation: (operation) => {
      if (!operations.has(operation.operationId)) {
        throw new Error(`Recovery operation ${operation.operationId} is not recorded in this store`)
      }
      operations.set(operation.operationId, operation)
    },
    readRecoveryOperation: (operationId, caller) =>
      callers.get(operationId)?.has(caller.callerId) ? operations.get(operationId) : undefined,
    listRecoveryOperations: (scope) => {
      const cutoff = Date.now() - RECOVERY_OPERATION_RETENTION_MS
      return [...operations.values()].filter((operation) => {
        if (scope.sessionId !== undefined && recoveryTargetSessionId(operation.target) !== scope.sessionId) return false
        if (operation.state !== "succeeded" && operation.state !== "failed") return true
        if (operation.facts.cleanup.value !== "verified_clear") return true
        if (operation.facts.persistence.value === "pending") return true
        return operation.updatedAt >= cutoff
      })
    },
    appendEvent: committedAppend,
    getMessages: () => [],
    getLatestUserMessageId: () => undefined,
    getTodos: () => [],
    listPermissions: () => [],
    listQuestions: () => [],
    stalePermission: () => {},
    markRecovering: () => {},
    markSessionInterrupted: () => {},
    consumeRecoveryError: () => null,
    ...overrides,
    acquireTurnLease: overrides.acquireTurnLease ?? ((sessionId) => {
      if (leases.has(sessionId)) return undefined
      // Never reused: a released lease id that came back would make a stale
      // writer's fence pass.
      const leaseId = `${sessionId}:fake:${++mintedLeases}`
      leases.set(sessionId, { leaseId, acquiredAt: Date.now() })
      return leaseId
    }),
    releaseTurnLease: overrides.releaseTurnLease ?? ((sessionId, leaseId) => {
      if (leases.get(sessionId)?.leaseId === leaseId) leases.delete(sessionId)
    }),
    readTurnAuthority: overrides.readTurnAuthority ?? ((sessionId) => leases.get(sessionId)),
    // Fences by default. A fake that accepted any lease would let every
    // caller's test pass against a store that never checked one.
    finishTurn: (input: AgentRuntimeTurnFinishInput) => {
      if (leases.get(input.sessionId)?.leaseId !== input.leaseId) {
        throw new AgentRuntimeStaleTurnError(input.sessionId)
      }
      return overrides.finishTurn ? overrides.finishTurn(input) : { events: [] }
    },
  }
}
