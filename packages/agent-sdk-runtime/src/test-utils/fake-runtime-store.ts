import type { CompatEvent } from "../compat-events"
import type {
  AgentRuntimeCommittedCompatOutput,
  AgentRuntimeStoreWithRecovery,
} from "../harnesses/shared/runtime-store"

/** A commit receipt with exactly the fields the port promises — nothing invented. */
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

/**
 * An inert store that satisfies every *required* member of the runtime-store
 * port, so a test can override only the handful it cares about.
 *
 * Hand-rolled fakes drifted from the port repeatedly (the ACP and SDK fakes in
 * `store-lifecycle.test.ts` were both missing `listQuestions`, and several
 * adapter tests smuggled two-method objects past it with `as AcpRuntimeStore`).
 * Building on one base means adding a required member to the port breaks here
 * once instead of silently leaving every fake incomplete.
 *
 * Optional members (`finishTurn`, `close`, and the owner-key group) are left
 * absent unless overridden: adapters branch on their presence, so filling them in
 * would change what is under test.
 */
export function fakeRuntimeStore(
  overrides: Partial<AgentRuntimeStoreWithRecovery> = {},
): AgentRuntimeStoreWithRecovery {
  const leases = new Map<string, string>()
  return {
    listSessions: () => [],
    getSession: () => null,
    bindSession: () => {},
    updateSessionConfig: () => null,
    updateSession: () => null,
    getSessionConfig: () => null,
    deleteSession: () => {},
    getAgentSessionId: () => null,
    startTurn: () => {},
    appendEvent: committedAppend,
    getMessages: () => [],
    getTodos: () => [],
    listPermissions: () => [],
    listQuestions: () => [],
    stalePermission: () => {},
    markRecovering: () => {},
    markSessionInterrupted: () => {},
    consumeRecoveryError: () => null,
    ...overrides,
    acquireTurnLease: overrides.acquireTurnLease ?? ((sessionId) => {
      if (leases.has(sessionId)) return
      const lease = `${sessionId}:fake`
      leases.set(sessionId, lease)
      return lease
    }),
    releaseTurnLease: overrides.releaseTurnLease ?? ((sessionId, leaseId) => {
      if (leases.get(sessionId) === leaseId) leases.delete(sessionId)
    }),
  }
}
