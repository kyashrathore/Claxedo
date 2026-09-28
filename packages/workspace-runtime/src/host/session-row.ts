import { declaredPermissionModes } from "@claxedo/agent-runtime-contract"
import { sessionUpdated, withDir } from "@claxedo/agent-sdk-runtime/compat-events"
import type { KeptPermissionMode } from "@claxedo/harness/contract"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"
import type { AgentRuntimeStore } from "./contracts"

export type SessionRowWrite = <T>(sessionId: string, write: () => Promise<T>) => Promise<T>

/**
 * The one path a selection write takes: the write lands in the store, then the
 * session's row is published when its config moved, so every client's copy of
 * the row follows whichever path changed it. A write that left the row's
 * config as it was publishes nothing; one that failed after moving it still
 * publishes. Writes of one session that overlap publish once, when the last
 * of them ends, against the row as it was before the first began: a harness
 * reports its mode from inside the config write that moved it.
 */
export function createSessionRowWrites(input: { store: AgentRuntimeStore; eventHub: Pick<RuntimeEventHub, "publishGlobal"> }): SessionRowWrite {
  const rowConfig = (sessionId: string) => JSON.stringify(input.store.getSession(sessionId)?.config ?? null)
  const open = new Map<string, { writes: number; before: string }>()
  return async (sessionId, write) => {
    const pending = open.get(sessionId) ?? { writes: 0, before: rowConfig(sessionId) }
    pending.writes++
    open.set(sessionId, pending)
    try {
      return await write()
    } finally {
      if (--pending.writes === 0) {
        open.delete(sessionId)
        const session = input.store.getSession(sessionId)
        if (session && JSON.stringify(session.config ?? null) !== pending.before) {
          input.eventHub.publishGlobal(withDir(session.directory, sessionUpdated(session)))
        }
      }
    }
  }
}

export type PermissionModeWrite = (sessionId: string, mode: KeptPermissionMode) => Promise<void>

/**
 * The one write of a session's permission mode, whichever path moved it: a
 * client's pick, a turn's own mode, or a mode the harness reports keeping on
 * create, on resume or on its own. The row names the mode by the harness's
 * label only for a harness the contract declares no modes for, since a client
 * has no other place to read that name from.
 */
export function createPermissionModeWrite(input: { store: AgentRuntimeStore; writeRow: SessionRowWrite }): PermissionModeWrite {
  return (sessionId, mode) => input.writeRow(sessionId, async () => {
    const stored = input.store.getSessionConfig(sessionId)
    if (!stored) throw new Error(`Session ${sessionId} has no runtime config`)
    const label = mode.modeId && !declaredPermissionModes(stored.harness) ? mode.label : null
    if ((stored.permissionMode ?? null) === mode.modeId && (stored.permissionModeLabel ?? null) === label) return
    if (!input.store.updateSessionConfig(sessionId, { permissionMode: mode.modeId, permissionModeLabel: label })) {
      throw new Error(`Session ${sessionId} has no runtime config`)
    }
  })
}
