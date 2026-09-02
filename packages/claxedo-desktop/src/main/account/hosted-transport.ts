/**
 * Stall recovery for hosted control-plane requests from Electron main.
 *
 * Live Cloudflare deployments intermittently stall a request that reuses a
 * keep-alive connection: the edge delivers the request headers to the Worker
 * but response headers never come back, so the fetch sits until the transport's
 * own five-minute headers timeout. The desktop's signed bootstrap awaited one
 * control-plane read, so one stalled request left the renderer on the splash screen
 * indefinitely. (Full audit trail: docs/handoffs/cloudflare-multiplayer-migration.md,
 * "Continuation 2026-08-31".)
 *
 * The recovery is the same one the token transport uses: bound the wait for
 * response HEADERS, abort the stalled attempt (destroying the poisoned
 * socket), and retry once on a fresh connection. Retrying is confined to
 * requests the caller declares retryable — GET/HEAD reads — because aborting
 * before the retry guarantees only that the STALLED attempt cannot have been
 * processed; a slow-but-delivered mutation cannot be told apart from a stall,
 * so unsafe methods keep their single attempt and the transport default.
 */

type HostedFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>

export const HOSTED_HEADERS_STALL_MS = 8_000
export const HOSTED_RETRY_HEADERS_STALL_MS = 20_000

class HostedHeadersStallError extends Error {
  constructor(afterMs: number) {
    super(`hosted request produced no response headers within ${String(afterMs)}ms`)
  }
}

async function attemptOnce(
  fetchImpl: HostedFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  stallMs: number,
  track: (controller: AbortController) => () => void,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const untrack = track(controller)
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true })
  let stalled: HostedHeadersStallError | undefined
  const handle = setTimeout(() => {
    stalled = new HostedHeadersStallError(stallMs)
    controller.abort(stalled)
  }, stallMs)
  handle.unref?.()
  let settled = false
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    settled = true
    return response
  } catch (error) {
    // The abort we dispatched surfaces as the transport's own rejection; the
    // retry decision keys on the stall type, so translate it here. A parent
    // cancellation is never translated — it must propagate and end the call.
    throw parentSignal?.aborted ? error : stalled ?? error
  } finally {
    clearTimeout(handle)
    // On success the parent link stays: a streaming response's body read is
    // still bound to this attempt's signal, and the parent (caller abort or
    // logout) must be able to end it for the response's whole life.
    if (!settled) {
      parentSignal?.removeEventListener("abort", abortFromParent)
    }
    untrack()
  }
}

/**
 * One hosted request, with a single fresh-connection retry when a retryable
 * request stalls before response headers.
 *
 * `track` registers each attempt's AbortController with the caller (the
 * account service aborts every active request on logout) and returns the
 * matching deregistration.
 */
export async function fetchHostedWithStallRecovery(
  fetchImpl: HostedFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  track: (controller: AbortController) => () => void,
  parentSignal?: AbortSignal,
  budgets: { stallMs: number; retryStallMs: number } = {
    stallMs: HOSTED_HEADERS_STALL_MS,
    retryStallMs: HOSTED_RETRY_HEADERS_STALL_MS,
  },
): Promise<Response> {
  const retryable = init.method === "GET" || init.method === "HEAD"
  if (!retryable) {
    // Single attempt, no headers deadline: a mutation that is merely slow must
    // not be aborted, because a delivered-but-slow request is indistinguishable
    // from a stalled one and a retry could apply it twice.
    const controller = new AbortController()
    const untrack = track(controller)
    const abortFromParent = () => controller.abort(parentSignal?.reason)
    if (parentSignal?.aborted) abortFromParent()
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true })
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      parentSignal?.removeEventListener("abort", abortFromParent)
      untrack()
    }
  }
  try {
    return await attemptOnce(fetchImpl, url, init, budgets.stallMs, track, parentSignal)
  } catch (error) {
    if (!(error instanceof HostedHeadersStallError) || parentSignal?.aborted) throw error
    return await attemptOnce(fetchImpl, url, init, budgets.retryStallMs, track, parentSignal)
  }
}
