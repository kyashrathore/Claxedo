import type { CompatEvent } from "../compat-events"
import type {
  AgentRuntimeCommittedCompatOutput,
  AgentRuntimeStoreWithRecovery,
} from "../harnesses/shared/runtime-store"
import { MemoryRuntimeStore } from "../stores/memory"

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
export function committedStartTurn(input: unknown) {
  return new MemoryRuntimeStore().startTurn(
    input as Parameters<MemoryRuntimeStore["startTurn"]>[0],
  )
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
    startTurn: committedStartTurn,
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
