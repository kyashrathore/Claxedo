import type { CompatEvent } from "../compat-events"
import type {
  AgentRuntimeCommittedCompatOutput,
  AgentRuntimeStoreWithRecovery,
} from "../harnesses/shared/runtime-store"

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

/** A complete inert store whose individual operations can be replaced by a test. */
export function fakeRuntimeStore(
  overrides: Partial<AgentRuntimeStoreWithRecovery> = {},
): AgentRuntimeStoreWithRecovery {
  return {
    listSessions: () => [],
    getSession: () => null,
    bindSession: () => {},
    updateSessionConfig: () => null,
    updateSession: () => null,
    getSessionConfig: () => null,
    deleteSession: () => {},
    getAgentSessionId: () => null,
    startTurn: (input) => {
      const row = input as { sessionId: string; agentSessionId?: string }
      return {
        sessionId: row.sessionId,
        seq: 1,
        createdAt: 1,
        ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
        events: [],
      }
    },
    finishTurn: () => ({ events: [] }),
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
  }
}
