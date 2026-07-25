/**
 * A replayed buffer is a RECORDING, not live output.
 *
 * Two families of escape sequence are meaningful when they stream from a live
 * program and actively harmful when they are replayed out of a transcript:
 *
 * 1. **Queries.** A terminal ANSWERS these by writing a reply back into the
 *    pty. Replaying `CSI > q` (XTVERSION) makes the reattaching terminal reply
 *    to a program that asked the question minutes ago — and if that program has
 *    exited, the shell now reading the pty receives the reply as typed input
 *    and echoes it. That is the `^[P>|xterm.js(6.1.0-beta.289)^[\` and
 *    `1;95;0c`-shaped junk that appears next to the prompt after a restore.
 *
 * 2. **Mode sets.** Replaying `?1003h` re-arms mouse tracking in the terminal
 *    because a TUI armed it during the recording. The program that wanted those
 *    reports may be long gone, so every subsequent pointer move sprays
 *    `ESC[<35;…M` into the shell. Modes must come from ONE place — the live
 *    preamble built from the emulator that mirrors the running process
 *    (`mode-tracker.ts`) — never from the transcript, which is stale by
 *    definition.
 *
 * Everything else is left byte-for-byte: colours, cursor positioning, erases
 * and text are what make the restored screen look like the one the user left.
 *
 * Applied to the replay only. The LIVE stream keeps its queries and mode sets —
 * those are a running program talking to its terminal, and must go through.
 *
 * DUPLICATED, deliberately, from workspace-runtime's `pty/replay-sanitize.ts`.
 * There are TWO independent replay paths and each must sanitize its own:
 *   - the PTY host replays `session.buffer` to a reattaching socket;
 *   - the renderer replays its OWN localStorage snapshot on mount, which never
 *     goes near the server.
 * The app cannot import from the runtime package's internals, and a shared
 * package for ~90 lines of regex is not worth the coupling. `replay-sanitize.test.ts`
 * is duplicated alongside it so the two cannot drift silently.
 */

/**
 * Sequences that provoke a reply from the terminal.
 *
 * Kept deliberately narrow — each entry is a query with a known answer-back,
 * not merely an uncommon sequence. Anything not listed passes through, because
 * a false positive here silently corrupts a restored screen.
 */
const QUERY_PATTERNS: RegExp[] = [
  // Primary/secondary/tertiary Device Attributes: CSI c, CSI > c, CSI = c
  /\x1b\[[>=]?[0-9;]*c/g,
  // Device Status Report / cursor position: CSI n, CSI ? n  (CSI 6n = CPR)
  /\x1b\[\??[0-9;]*n/g,
  // XTVERSION: CSI > q  — note CSI ... q is also DECSCUSR (cursor style), so
  // only the `>` private form is a query.
  /\x1b\[>[0-9;]*q/g,
  // DECRQM (request mode): CSI ? Ps $ p
  /\x1b\[\??[0-9;]*\$p/g,
  // XTGETTCAP and other DCS requests: DCS + q ... ST
  /\x1bP\+q[^\x1b\x07]*(?:\x1b\\|\x07)/g,
  // OSC colour queries end with `?` before the terminator: OSC 10;? ST
  /\x1b\][0-9]+;\?(?:\x1b\\|\x07)/g,
]

/**
 * Mode sets the live preamble owns. Mouse tracking (9, 1000–1003), mouse
 * encodings (1005/1006/1015/1016), focus reporting (1004), bracketed paste
 * (2004), application cursor/keypad (1, 66), and the kitty keyboard protocol.
 *
 * Alternate-screen toggles (47/1047/1049) are stripped too: which buffer a
 * restore lands in is decided by the restore logic, and a stray toggle from the
 * transcript would either hide the restored scrollback or strand the terminal
 * in a buffer nothing is drawing to.
 */
const MODE_PATTERNS: RegExp[] = [
  // DECSET/DECRST for the private modes listed above. Matches a whole
  // parameter list so `CSI ? 1002 ; 1006 h` goes as one.
  /\x1b\[\?(?:9|10\d\d|1015|1016|2004|1|66|47)(?:;[0-9]+)*[hl]/g,
  // Kitty keyboard protocol: CSI > flags u, CSI = flags ; mode u, CSI < n u
  /\x1b\[[><=][0-9;]*u/g,
]

/**
 * Strip reply-provoking queries and stale mode sets from a buffer that is about
 * to be replayed to a reattaching terminal.
 *
 * Pure and allocation-light: returns the input unchanged when there is nothing
 * to strip, which is the common case for a plain shell.
 */
export function sanitizeReplay(data: string): string {
  if (!data) return data
  // Fast path: no ESC at all means nothing to strip.
  if (!data.includes("\x1b")) return data

  let out = data
  for (const pattern of QUERY_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, "")
  }
  for (const pattern of MODE_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, "")
  }
  return out
}
