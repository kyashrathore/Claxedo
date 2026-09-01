/**
 * Bound a step that must complete before the app can render anything.
 *
 * `main.tsx` awaits auth initialization before its single `render()` call, so
 * a step that never settles produces the worst failure this shell has: the
 * index.html spinner forever, an empty `#root`, no error, no recovery, and
 * nothing in the console to explain it. Observed live — the control plane's
 * edge withheld a response to `/api/auth/get-session`, and the app sat on the
 * loader indefinitely while every other origin call succeeded.
 *
 * A hang is not more trustworthy than a failure, it is only quieter. Rejecting
 * turns it into the startup-failure panel, which names the step and offers a
 * retry. This mirrors the reveal gate's rule in `app.tsx` — wait for the thing
 * that should happen, but never wait forever.
 */
export const STARTUP_STEP_TIMEOUT_MS = 20_000

export class StartupTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(
      `${step} did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
        `Check your connection to the Claxedo server, then try again.`,
    )
    this.name = "StartupTimeoutError"
  }
}

export async function withStartupTimeout<T>(
  work: Promise<T>,
  step: string,
  options: {
    timeoutMs?: number
    setTimeout?: (callback: () => void, ms: number) => unknown
    clearTimeout?: (handle: never) => void
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? STARTUP_STEP_TIMEOUT_MS
  const start = options.setTimeout ?? globalThis.setTimeout
  const stop = options.clearTimeout ?? globalThis.clearTimeout
  let handle: unknown
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        handle = start(() => reject(new StartupTimeoutError(step, timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    // The losing timer must not hold the event loop (or fire into a settled
    // race) once the real work has answered.
    if (handle !== undefined) (stop as (value: unknown) => void)(handle)
  }
}
