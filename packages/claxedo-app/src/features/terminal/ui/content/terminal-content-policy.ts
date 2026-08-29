export function shouldMountTerminalPane(input: { visible: boolean; ptyReady: boolean; activated: boolean }) {
  // Require `activated` before the first WebSocket attach. Pending→real route
  // adoption (meta + URL) settles during the activation delay; mounting earlier
  // opens a socket that route/intent churn then tears down (cloud D blank xterm,
  // double `client disconnected` before pty.firstByte).
  // Once activated, keep the pane mounted while hidden so tab switches stay warm.
  return input.ptyReady && input.activated
}

/**
 * Bind a pending creator to a server PTY without cross-adopting a sibling create.
 * Prefer an exact sessionId match; otherwise only adopt when exactly one new
 * unclaimed `pty_*` appeared since create started.
 */
export function pickAdoptedPty<T extends { id: string; sessionId?: string }>(
  rows: readonly T[],
  before: Set<string>,
  sessionId: string | undefined,
  claimedIds?: ReadonlySet<string>,
) {
  const candidates = rows.filter(
    (row) => row.id.startsWith("pty_") && !before.has(row.id) && !claimedIds?.has(row.id),
  )
  if (sessionId) {
    const matched = candidates.filter((row) => row.sessionId === sessionId)
    return matched.length === 1 ? matched[0] : undefined
  }
  return candidates.length === 1 ? candidates[0] : undefined
}
