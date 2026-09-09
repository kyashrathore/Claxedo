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
 * the other heuristics below (restore sizing, SIGWINCH forcing, settle
 * delays), which are about how to reconnect, not about what the program's
 * modes are.
 */

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
