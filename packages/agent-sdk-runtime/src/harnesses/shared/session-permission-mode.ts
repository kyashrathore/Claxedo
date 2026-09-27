import { sessionUpdated, withDir } from "../../compat-events"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type { AgentRuntimeStoreCore } from "./runtime-store"

/**
 * The one write of a session's permission mode. Every path that changes it (a
 * client's pick, a turn's own mode, a mode the harness accepted mid-turn, an
 * agent that kept another mode on resume) lands here, and the session row is
 * published after, so every client's copy of the row follows whichever path
 * moved it.
 */
export function storePermissionMode(
  target: { readonly store: Pick<AgentRuntimeStoreCore, "getSession" | "getSessionConfig" | "updateSessionConfig">; readonly eventHub?: RuntimeEventHub },
  sessionId: string,
  modeId: string | null,
) {
  const { store, eventHub } = target
  if ((store.getSessionConfig(sessionId)?.permissionMode ?? null) === modeId) return
  if (!store.updateSessionConfig(sessionId, { permissionMode: modeId })) throw new Error(`Session ${sessionId} has no runtime config`)
  const session = store.getSession(sessionId)
  if (session?.directory) eventHub?.publishGlobal(withDir(session.directory, sessionUpdated(session)))
}
