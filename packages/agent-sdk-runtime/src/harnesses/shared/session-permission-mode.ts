import { sessionUpdated, withDir } from "../../compat-events"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type { AgentRuntimeStoreCore } from "./runtime-store"

/**
 * The one write of a session's permission mode. Every path that changes it (a
 * client's pick, a turn's own mode, a mode the harness accepted mid-turn, an
 * agent that kept another mode on resume) lands here, and the session row is
 * published after, so every client's copy of the row follows whichever path
 * moved it. An agent that lists its own modes passes the listed name with the
 * id, and the row carries both.
 */
export function storePermissionMode(
  target: { readonly store: Pick<AgentRuntimeStoreCore, "getSession" | "getSessionConfig" | "updateSessionConfig">; readonly eventHub?: RuntimeEventHub },
  sessionId: string,
  modeId: string | null,
  label?: string,
) {
  const { store, eventHub } = target
  const nextLabel = modeId === null ? null : label ?? null
  const stored = store.getSessionConfig(sessionId)
  if ((stored?.permissionMode ?? null) === modeId && (stored?.permissionModeLabel ?? null) === nextLabel) return
  if (!store.updateSessionConfig(sessionId, { permissionMode: modeId, permissionModeLabel: nextLabel })) throw new Error(`Session ${sessionId} has no runtime config`)
  const session = store.getSession(sessionId)
  if (session?.directory) eventHub?.publishGlobal(withDir(session.directory, sessionUpdated(session)))
}

export function listedModeName(state: { readonly modes: readonly { readonly id: string; readonly name: string }[] }, modeId: string | null | undefined) {
  return modeId ? state.modes.find((mode) => mode.id === modeId)?.name : undefined
}
