import type { CompatEvent } from "../compat-events"
import { AgentRuntimeStaleTurnError } from "../harnesses/shared/runtime-store"
import type {
  AgentRuntimeCommittedCompatOutput,
  AgentRuntimeStoreWithRecovery,
  AgentRuntimeTurnFinishInput,
  AgentRuntimeTurnStartInput,
} from "../harnesses/shared/runtime-store"
import { MemoryRuntimeStore } from "../stores/memory"
import type { RecoveryOperation, RecoveryTarget } from "@claxedo/agent-runtime-contract"

/** Matches the uniqueness the durable stores enforce with a unique index. */
function recoveryRequestKey(target: RecoveryTarget, callerId: string, requestId: string) {
  const scope = target.scope === "machine"
    ? `machine:${target.machineId}`
    : target.scope === "harness"
      ? `harness:${target.workspaceId}:${target.harnessKey}`
      : `session:${target.workspaceId}:${target.sessionId}`
  return `${scope}|${callerId}|${requestId}`
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
      return { created: true }
    },
    updateRecoveryOperation: (operation) => {
      if (!operations.has(operation.operationId)) {
        throw new Error(`Recovery operation ${operation.operationId} was never recorded in this store`)
      }
      operations.set(operation.operationId, operation)
    },
    readRecoveryOperation: (operationId) => operations.get(operationId),
    listRecoveryOperations: (scope) => [...operations.values()].filter((operation) =>
      scope.sessionId === undefined
      || ((operation.target.scope === "turn" || operation.target.scope === "session")
        && operation.target.sessionId === scope.sessionId)
    ),
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
      if (input.leaseId !== undefined && leases.get(input.sessionId)?.leaseId !== input.leaseId) {
        throw new AgentRuntimeStaleTurnError(input.sessionId)
      }
      return overrides.finishTurn ? overrides.finishTurn(input) : { events: [] }
    },
  }
}
