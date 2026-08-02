/**
 * The "this shell is not the one you left" separator.
 *
 * When a PTY is COLD-RESTORED — the process that owned it is gone and we have
 * spawned a fresh shell, seeding its buffer from disk history — the renderer
 * shows the old scrollback with a new prompt underneath it. Nothing in that
 * picture tells the user their session died: the prompt just appears, and any
 * state they had (a running command, an activated venv, a cd) is silently gone.
 *
 * A dim separator between the restored content and the fresh shell makes the
 * seam visible, the way VS Code's "History restored" line does.
 *
 * NOT emitted when the session is merely re-attached (a socket reconnect to a
 * still-live PTY) — nothing died, so there is no seam to mark.
 */

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

/**
 * Rendered on its own line, padded so it reads as a rule rather than a message.
 * Carries its own leading newline: the restored buffer ends wherever the old
 * session stopped, which is rarely at a line boundary.
 */
export const SESSION_RESTORED_NOTICE =
  `\r\n${DIM}─── Session contents restored ───${RESET}\r\n`

/**
 * Whether a freshly created session should carry the notice.
 *
 * Only when BOTH are true:
 *  - it was created as the replacement for a specific previous PTY, and
 *  - that PTY's history actually produced content to restore.
 *
 * A replacement whose history was empty has nothing above the prompt, so a
 * separator would be marking a seam the user cannot see.
 */
export function shouldMarkRestored(input: {
  previousPtyId: string | undefined
  restoredLength: number
}): boolean {
  return !!input.previousPtyId && input.restoredLength > 0
}
