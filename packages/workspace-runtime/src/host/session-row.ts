import { sessionUpdated, withDir } from "@claxedo/agent-sdk-runtime/compat-events"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"
import type { AgentRuntimeStore } from "./contracts"

export type SessionRowWrite = <T>(sessionId: string, write: () => Promise<T>) => Promise<T>

/**
 * The one path a selection write takes: the write lands in the store, then the
 * session's row is published when its config moved, so every client's copy of
 * the row follows whichever path changed it. A write that left the row's
 * config as it was publishes nothing.
 */
export function createSessionRowWrites(input: { store: AgentRuntimeStore; eventHub: Pick<RuntimeEventHub, "publishGlobal"> }): SessionRowWrite {
  const rowConfig = (sessionId: string) => JSON.stringify(input.store.getSession(sessionId)?.config ?? null)
  return async (sessionId, write) => {
    const before = rowConfig(sessionId)
    const result = await write()
    const session = input.store.getSession(sessionId)
    if (session && JSON.stringify(session.config ?? null) !== before) {
      input.eventHub.publishGlobal(withDir(session.directory, sessionUpdated(session)))
    }
    return result
  }
}
