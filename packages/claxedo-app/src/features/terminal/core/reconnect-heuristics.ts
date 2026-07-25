const AGENT_TUI_RE = /\b(?:codex|claude|opencode|gemini|cursor-agent|cursor)\b/i

export function isLikelyTui(input: {
  snapshotWasAltScreen: boolean
  initialCommand?: string
  title?: string
}) {
  if (input.snapshotWasAltScreen) return true
  if (AGENT_TUI_RE.test(input.initialCommand ?? "")) return true
  if (AGENT_TUI_RE.test(input.title ?? "")) return true
  return false
}

/**
 * REMOVED: `filterModeSequences`.
 *
 * The renderer used to persist a snapshot of the terminal modes it had scanned
 * out of the stream, then replay that snapshot on the next mount — filtered by
 * `likelyTui`, which is a match on the tab's TITLE. A tab merely NAMED "Claude"
 * therefore re-armed mouse reporting on every mount, whether or not a TUI was
 * running, which sprayed `ESC[<35;…M` reports into the shell prompt.
 *
 * Modes are now resynced from live server-side truth: the PTY host mirrors its
 * output through a headless xterm and sends a preamble built from the ACTUAL
 * current mode state on every attach (workspace-runtime `pty/mode-tracker.ts`).
 * A snapshot the renderer guessed is strictly worse than asking the process,
 * so there is nothing left to filter.
 *
 * `isLikelyTui` survives because the OTHER heuristics it feeds — cursor replay
 * strategy, SIGWINCH forcing, settle delays — are about how to reconnect, not
 * about what the program's modes are.
 */

export function cursorPlan(input: {
  likelyTui: boolean
  splitWidthChanged: boolean
  isReload: boolean
  snapshotHasBuffer: boolean
  snapshotWasAltScreen: boolean
  snapshotCursor?: number
  lookbackBytes?: number
}) {
  const LOOKBACK_BYTES = input.lookbackBytes ?? 256 * 1024

  const hasPersistedBuffer = input.snapshotHasBuffer
  // REMOVED: `tailOnReload`, which asked the server for the LIVE TAIL when a
  // reload left us with no persisted buffer and no cursor.
  //
  // That is precisely the case where the server's buffer is the only copy of
  // the session's scrollback, and asking for the tail throws it away: the PTY
  // is alive with a full Claude Code session behind it and the user gets an
  // empty screen. Observed directly — pty running, 22KB of scrollback held
  // server-side, terminal blank.
  //
  // The live tail is only ever the right ask when the client ALREADY has the
  // content locally (the `!likelyTui && hasPersistedBuffer` branch below),
  // because then replaying would duplicate it. With nothing local, replay.
  const hasAltSnapshot = input.snapshotWasAltScreen && input.snapshotHasBuffer
  const splitTuiLiveTail = input.likelyTui && input.splitWidthChanged && input.snapshotHasBuffer

  const lookback =
    input.likelyTui &&
    typeof input.snapshotCursor === "number" &&
    Number.isSafeInteger(input.snapshotCursor) &&
    input.snapshotCursor > 0
      ? Math.max(0, input.snapshotCursor - LOOKBACK_BYTES)
      : undefined

  const tuiLiveTail = input.isReload && hasAltSnapshot
  const useLiveTailCursor =
    (!input.likelyTui && hasPersistedBuffer) || tuiLiveTail || splitTuiLiveTail

  const cursorStart = input.likelyTui
    ? useLiveTailCursor
      ? undefined
      : lookback ?? input.snapshotCursor
    : useLiveTailCursor
      ? undefined
      : input.snapshotCursor

  const cursorParam = cursorStart !== undefined ? cursorStart : useLiveTailCursor ? -1 : 0

  return { cursorStart, cursorParam, useLiveTailCursor }
}

export function restoreSize(input: {
  likelyTui: boolean
  splitWidthChanged: boolean
  mountCols: number
  snapshotCols?: number
  snapshotRows?: number
  backendCols: number
  backendRows: number
}) {
  const rows = input.snapshotRows && input.snapshotRows > 0 ? input.snapshotRows : input.backendRows
  const currentCols = input.mountCols > 2 ? input.mountCols : input.backendCols
  const minSaneSnapshotCols = Math.max(12, Math.floor(Math.max(currentCols, input.backendCols) * 0.35))
  const snapshotCols =
    input.snapshotCols && input.snapshotCols >= minSaneSnapshotCols
      ? input.snapshotCols
      : undefined
  const cols =
    input.likelyTui && input.splitWidthChanged
      ? input.mountCols
      : snapshotCols ?? currentCols

  return { cols, rows }
}

export function initialDelay(input: { likelyTui: boolean }) {
  if (input.likelyTui) {
    return {
      settleMs: 180,
      fallbackMs: 1200,
    }
  }

  return {
    settleMs: 100,
    fallbackMs: 500,
  }
}
