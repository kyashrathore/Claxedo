/**
 * W4.1 — bounded retry for control-plane Convex calls.
 *
 * ## The rule this module exists to enforce
 *
 * `withTimeout` (`./timeout.ts`) bounds how long the CALLER waits. It does not
 * cancel the underlying fetch, and Convex has no request-cancellation channel
 * from `ConvexHttpClient`. So a mutation that "timed out" may still be running
 * server-side and may still commit. Retrying it is not "trying again" — it is
 * running the operation a second time, concurrently with the first.
 *
 * That makes retry eligibility a property of the OPERATION, not of the error:
 *
 *   - Reads are always retryable. A duplicate query has no effect.
 *   - Mutations are retryable ONLY when the function itself is idempotent on
 *     an argument the caller supplies — an `operationId`, an idempotency key,
 *     or a monotonic guard such as a `source_ts` watermark. The caller
 *     asserts that by passing `idempotent: true`, which is why the flag has no
 *     default: an un-annotated mutation gets zero retries.
 *
 * A retry that fires on a *timeout* for a non-idempotent write is the specific
 * bug this shape prevents, and it is the one most likely to be written by
 * accident, because the timeout looks like "nothing happened."
 *
 * ## What counts as retryable, error-side
 *
 * Timeouts and 5xx only. A 4xx is the server rejecting the request on its
 * merits — replaying it burns budget for a guaranteed identical rejection.
 * `ControlPlaneAuthError` carries an explicit `status`, so it is classified on
 * that rather than on message text; the 503 the executor synthesizes for a
 * timeout is therefore retryable, while its 401/403 siblings are not.
 *
 * ## Backoff
 *
 * Exponential with jitter in the top half of the window, mirroring
 * `claxedo-app/src/platform/sync/global-sdk/reconnect-backoff.ts` — the same
 * shape, with an injectable `random` so tests are deterministic. Jitter matters
 * here for the same reason it matters there: on a Convex hiccup every isolate
 * retries at once, and a fixed delay turns one blip into a synchronized second
 * wave.
 *
 * ONE retry by default. This sits under a caller who is already holding a
 * request open behind a 5-10s timeout, so the budget is small on purpose: two
 * attempts at 10s each is already at the edge of what a client will wait for,
 * and more attempts push a *slow* dependency into looking like a *dead* one.
 */

export const CONVEX_RETRY_BASE_DELAY_MS = 50
export const CONVEX_RETRY_MAX_DELAY_MS = 1_000
export const CONVEX_DEFAULT_MAX_RETRIES = 1

export type ConvexRetryOptions = {
  /**
   * Retries AFTER the first attempt. 0 disables retry entirely; the default is
   * one, so an eligible call makes at most two attempts.
   */
  maxRetries?: number
  /** Injectable for deterministic jitter in tests. */
  random?: () => number
  /** Injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Delay before retry number `attempt` (0 = the first retry). Exponential from
 * the base delay to the ceiling, then jittered across the top half of that
 * window.
 */
export function convexRetryDelayMs(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(CONVEX_RETRY_MAX_DELAY_MS, CONVEX_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

/**
 * True for the failures where a second attempt can plausibly do better:
 * request timeouts and server-side 5xx. Everything else — including every 4xx
 * and any error we cannot classify — is treated as terminal.
 *
 * Unclassifiable defaults to NOT retryable on purpose. Guessing "probably
 * transient" from an unknown error is how a non-idempotent write gets replayed.
 */
export function isRetryableConvexError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const shaped = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown }
  if (typeof shaped.status === "number") return shaped.status >= 500
  if (shaped.code === "control_plane_request_timeout") return true
  const text = `${typeof shaped.name === "string" ? shaped.name : ""} ${
    typeof shaped.message === "string" ? shaped.message : ""
  }`.toLowerCase()
  // The executor's timeout error carries an explicit status, so this text match
  // is for timeouts thrown from lower layers (undici/workerd fetch aborts).
  if (text.includes("timed out") || text.includes("timeout")) return true
  return false
}

/**
 * Run `attempt`, retrying eligible failures with jittered backoff.
 *
 * `idempotent` is REQUIRED rather than defaulted: every caller has to state
 * whether replaying its operation is safe. `false` still runs the operation
 * once — it just never runs it twice.
 */
export async function withConvexRetry<T>(
  input: { idempotent: boolean; attempt: () => Promise<T> },
  options: ConvexRetryOptions = {},
): Promise<T> {
  const maxRetries = input.idempotent ? options.maxRetries ?? CONVEX_DEFAULT_MAX_RETRIES : 0
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let retry = 0; ; retry += 1) {
    try {
      return await input.attempt()
    } catch (error) {
      if (retry >= maxRetries || !isRetryableConvexError(error)) throw error
      await sleep(convexRetryDelayMs(retry, random))
    }
  }
}
