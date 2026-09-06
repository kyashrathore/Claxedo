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
 * Terminal modes are resynced from live server-side truth: the PTY host
 * mirrors its output through a headless xterm and sends a preamble built from
 * the current mode state on every attach (workspace-runtime
 * `pty/mode-tracker.ts`). `isLikelyTui` plays no part in that — it only feeds
 * the other heuristics below (cursor replay strategy, SIGWINCH forcing, settle
 * delays), which are about how to reconnect, not about what the program's
 * modes are.
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
  // The live tail is only the right ask when the client already has the
  // content locally (the `!likelyTui && hasPersistedBuffer` branch below),
  // because replaying it then would duplicate what's on screen. A reload that
  // lands with no persisted buffer and no cursor must not ask for the tail
  // either: the server's buffer is the PTY's only copy of scrollback, and
  // asking for the tail there throws it away, leaving the screen blank behind
  // a session that is still alive.
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
