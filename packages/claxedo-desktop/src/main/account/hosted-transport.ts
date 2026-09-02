/**
 * One HTTP attempt, bounded by a single deadline — and the hosted
 * control-plane request built on top of it.
 *
 * `fetchWithDeadline` is shared by every request the account modules make:
 * hosted control-plane calls here, and the OAuth token endpoint in
 * `electron-seams.ts`. There is exactly one definition of what a bounded
 * attempt means: start the real fetch, abort it if the deadline elapses
 * before a response arrives, and report that as a distinguishable
 * `DeadlineExceededError`. A parent signal (an explicit caller cancellation,
 * or account logout) always wins over the deadline and is never translated
 * into a timeout — the caller asked to stop, it did not time out.
 *
 * There is no retry here, and never will be. A retry can only be safe when a
 * caller can tell "never reached the server" apart from "reached it, and it
 * is just slow" — across a real network that distinction is not observable,
 * so a retried mutation risks applying twice. A bounded deadline is the safe
 * half of that: the caller gets a clear, terminal error instead of a hang.
 *
 * Full incident history for why a retry used to live here:
 * docs/handoffs/cloudflare-multiplayer-migration.md.
 */

export type BoundedFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>

export class DeadlineExceededError extends Error {
  constructor(afterMs: number) {
    super(`request produced no response within ${String(afterMs)}ms`)
  }
}

export async function fetchWithDeadline(
  fetchImpl: BoundedFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  deadlineMs: number,
  options: {
    parentSignal?: AbortSignal
    /** Registers this attempt's controller with a caller-wide cancellation set (e.g. logout). */
    track?: (controller: AbortController) => () => void
    /**
     * Keep the deadline timer ref'd instead of the default unref'd.
     *
     * An unref'd timer must not be the event loop's only reason to stay
     * alive: on Windows, Bun does not fire an unref'd timer once every other
     * ref'd handle is gone, which turns a bounded deadline into a permanent
     * hang instead of a timeout. The OAuth token exchange can be the only
     * pending work on the loop (a directly injected `fetch` with no socket of
     * its own, as tests use), so it opts into a ref'd timer; every other
     * caller runs alongside Electron's own event sources and stays with the
     * default so a pending request cannot itself keep the process alive after
     * the user quits.
     */
    refTimer?: boolean
  } = {},
): Promise<Response> {
  const { parentSignal, track, refTimer = false } = options
  const controller = new AbortController()
  const untrack = track?.(controller)
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true })
  let timedOut: DeadlineExceededError | undefined
  const handle = setTimeout(() => {
    timedOut = new DeadlineExceededError(deadlineMs)
    controller.abort(timedOut)
  }, deadlineMs)
  if (!refTimer) handle.unref?.()
  let settled = false
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    settled = true
    return response
  } catch (error) {
    // The abort WE dispatched surfaces as the transport's own rejection;
    // translating it here means a caller can tell a deadline apart from a
    // real network failure without knowing the transport's error shape.
    throw parentSignal?.aborted ? error : timedOut ?? error
  } finally {
    clearTimeout(handle)
    // On success the parent link stays: a streaming response's body read is
    // still bound to this attempt's signal, and the parent (caller abort or
    // logout) must be able to end it for the response's whole life.
    if (!settled) parentSignal?.removeEventListener("abort", abortFromParent)
    untrack?.()
  }
}

export const HOSTED_REQUEST_DEADLINE_MS = 20_000

/**
 * One hosted control-plane request, bounded by `deadlineMs`. Reads and
 * mutations alike get exactly this: one attempt, one deadline.
 *
 * `track` registers the attempt's AbortController with the caller (the
 * account service aborts every active request on logout) and returns the
 * matching deregistration.
 */
export async function fetchHosted(
  fetchImpl: BoundedFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  track: (controller: AbortController) => () => void,
  parentSignal?: AbortSignal,
  deadlineMs: number = HOSTED_REQUEST_DEADLINE_MS,
): Promise<Response> {
  return fetchWithDeadline(fetchImpl, url, init, deadlineMs, { parentSignal, track })
}
