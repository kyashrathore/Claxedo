/**
 * Buffer-restore ordering for the terminal. When a PTY is remounted (tab switch,
 * split resize, or hard reload) the previously-serialized screen is written back
 * before the live socket resumes. The exact prefix/suffix and whether the last
 * lines get trimmed is subtle and easy to regress, so the decisions live here as
 * pure functions with a spec.
 *
 * Extracted from terminal.tsx.
 */

/**
 * Removes the last `count` lines from a serialized buffer, terminator included,
 * so a width-changed restore drops the stale wrapped-prompt line(s) and the live
 * shell redraws its prompt at a clean line boundary. A "line" is a run of
 * content ended by a `\r\n`, lone `\n`, or lone `\r`; the buffer's final line
 * may be unterminated (xterm's SerializeAddon emits `\r\n` between rows and NO
 * trailing newline, so a normal shell's serialized buffer ends with the
 * unterminated prompt row).
 *
 * Each removed line's own terminator is stripped, so a buffer that already ends
 * in a terminator still has its last line removed, and `count > 1` removes that
 * many lines — not the earlier verbatim-extracted behavior, which sliced to
 * `idx + 1` (keeping the terminator) and so no-op'd on a terminated buffer and
 * could only ever trim one unterminated trailing segment.
 *
 * Returns "" when there are fewer than `count` lines to remove, matching the
 * terminal's "if we can't cleanly trim, drop everything" fallback.
 */
export function trimTrailingLines(value: string, count: number): string {
  let out = value
  let left = count
  while (left > 0) {
    if (out.length === 0) return ""
    // Strip this line's own terminator (\r\n as a unit, or a lone \n / \r)...
    if (out.endsWith("\r\n")) out = out.slice(0, -2)
    else if (out.endsWith("\n") || out.endsWith("\r")) out = out.slice(0, -1)
    // ...then drop its content back to the end of the previous line's terminator.
    const idx = Math.max(out.lastIndexOf("\n"), out.lastIndexOf("\r"))
    out = idx < 0 ? "" : out.slice(0, idx + 1)
    left -= 1
  }
  return out
}

/**
 * Whether the restored buffer's trailing line(s) should be trimmed. Only done
 * for a normal-screen shell that was scrolled to the bottom and whose width
 * changed on remount (a stale wrapped prompt line would otherwise duplicate).
 * Never trimmed on reload, in a TUI/alt-screen, or when the user had scrolled up.
 */
export function shouldTrimRestoredTail(input: {
  readonly isReload: boolean
  readonly wasAltScreen: boolean
  readonly snapshotWasAtBottom: boolean | undefined
  readonly widthChanged: boolean
  readonly likelyTui: boolean
}): boolean {
  return (
    !input.isReload &&
    !input.wasAltScreen &&
    input.snapshotWasAtBottom !== false &&
    input.widthChanged &&
    !input.likelyTui
  )
}

/**
 * Assembles the exact byte sequence written to xterm to restore a buffer:
 * - alt-screen sessions enter the alternate buffer (`\x1b[?1049h`) first so a
 *   reload shows the last full-screen frame immediately;
 * - normal-screen sessions restore mode sequences then scrollback;
 * - TUIs get a trailing SGR reset so later resizes use theme defaults, not
 *   whatever attributes the app last set.
 */
export function buildRestoreWrite(input: {
  readonly wasAltScreen: boolean
  readonly modeSequences: string
  readonly restoreBuffer: string
  readonly likelyTui: boolean
}): string {
  const restoreTail = input.likelyTui ? "\x1b[0m" : ""
  return input.wasAltScreen
    ? `\x1b[?1049h${input.modeSequences}${input.restoreBuffer}${restoreTail}`
    : `${input.modeSequences}${input.restoreBuffer}${restoreTail}`
}
