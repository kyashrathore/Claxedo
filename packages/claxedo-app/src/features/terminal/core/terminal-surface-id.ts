/**
 * Sentinel terminal ids — values that occupy a surface's `terminalId` slot
 * without naming a live pty.
 *
 * `pending-*` already existed: the surface is committed to a terminal and is
 * waiting for the server to hand back a real pty id. `new` is the earlier
 * state — the surface exists but no terminal has been asked for yet, because
 * the user is still choosing where it should run.
 *
 * Both are collected here because three unrelated modules have to agree on
 * them: the surface renderer (which must not mount a pty), the route mapper
 * (which must not mint a URL for a terminal that does not exist), and the rail
 * (which opens the creator). A literal `"new"` spread across those three would
 * be a silent break the moment one of them drifted.
 */
export const NEW_TERMINAL_ID = "new"

export const PENDING_TERMINAL_PREFIX = "pending-"

/** True when `terminalId` names a real pty rather than a placeholder. */
export function isLiveTerminalId(terminalId: string | undefined): terminalId is string {
  if (!terminalId) return false
  if (terminalId === NEW_TERMINAL_ID) return false
  return !terminalId.startsWith(PENDING_TERMINAL_PREFIX)
}
