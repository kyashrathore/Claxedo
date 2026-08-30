export function shouldMountTerminalPane(input: { visible: boolean; ptyReady: boolean; activated: boolean }) {
  // Require `activated` before the first WebSocket attach. Pending→real route
  // adoption (meta + URL) settles during the activation delay; mounting earlier
  // opens a socket that route/intent churn then tears down (cloud D blank xterm,
  // double `client disconnected` before pty.firstByte).
  // Once activated, keep the pane mounted while hidden so tab switches stay warm.
  return input.ptyReady && input.activated
}

/** Bind a pending creator only to the PTY carrying its opaque request id. */
export function pickAdoptedPty<T extends { id: string; createRequestId?: string }>(
  rows: readonly T[],
  createRequestId: string | undefined,
) {
  if (!createRequestId) return undefined
  const matched = rows.filter((row) => row.createRequestId === createRequestId)
  return matched.length === 1 ? matched[0] : undefined
}

/**
 * Run one poll at a time. The next timeout is armed only after the current
 * async read settles, and stop() prevents both future runs and re-arming.
 */
export function startSingleFlightPoll(run: () => Promise<void>, intervalMs: number) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const cycle = async () => {
    if (stopped) return
    try {
      await run()
    } catch {}
    if (stopped) return
    timer = setTimeout(() => void cycle(), intervalMs)
  }

  void cycle()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
