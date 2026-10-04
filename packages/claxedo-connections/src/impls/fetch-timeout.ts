import type { IntegrationFetch } from "../types.js"

/**
 * Per-request ceiling for every reference impl's provider calls.
 *
 * A provider that accepts the connection and then never answers must not pin a
 * host request open indefinitely: `verify` and `listRepositories` run inline on
 * the connect path, so an unbounded call there is an unbounded connect.
 */
export const DEFAULT_INTEGRATION_FETCH_TIMEOUT_MS = 10_000

export type IntegrationFetchOptions = {
  fetchImpl?: IntegrationFetch
  /** Per-request ceiling in milliseconds. Defaults to {@link DEFAULT_INTEGRATION_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number
}

function deadlineSignal(timeoutMs: number, signal?: AbortSignal | null) {
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal?.reason)
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out", "TimeoutError")),
    timeoutMs,
  )

  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener("abort", abortFromCaller, { once: true })

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abortFromCaller)
    },
  }
}

/**
 * Wraps an injected (or global) fetch so every call it makes carries a deadline.
 *
 * Applied at the seam rather than at each call site so a new provider call
 * cannot be written without one, and so hosts get the same ceiling on all five
 * reference impls from a single knob.
 */
export function timeoutFetch(options: IntegrationFetchOptions = {}): IntegrationFetch {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTEGRATION_FETCH_TIMEOUT_MS
  return async (url, init) => {
    // Whether a runtime strips `Authorization` on a cross-origin redirect is
    // the runtime's policy, and not every runtime strips it. A credentialed
    // request that did not explicitly choose a redirect mode gets "manual":
    // a 3xx reaches the impl as an opaque response (which its closed
    // classification already turns into a failure) rather than the
    // credential being re-sent wherever Location points.
    const credentialed = (() => {
      const headers = new Headers(init?.headers)
      return headers.has("authorization") || headers.has("proxy-authorization") || headers.has("cookie")
    })()
    // A caller-supplied signal still cancels; the deadline only ever adds a
    // reason to abort, never removes one.
    const deadline = deadlineSignal(timeoutMs, init?.signal)
    try {
      return await fetchImpl(url, {
        ...init,
        ...(credentialed && init?.redirect === undefined ? { redirect: "manual" as const } : {}),
        signal: deadline.signal,
      })
    } finally {
      deadline.cleanup()
    }
  }
}
