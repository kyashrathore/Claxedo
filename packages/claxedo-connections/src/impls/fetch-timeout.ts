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
  return (url, init) => {
    const deadline = AbortSignal.timeout(timeoutMs)
    // A caller-supplied signal still cancels; the deadline only ever adds a
    // reason to abort, never removes one.
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    return fetchImpl(url, { ...init, signal })
  }
}
