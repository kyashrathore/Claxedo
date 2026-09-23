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
