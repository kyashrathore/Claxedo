export type ReviewContentRequest = {
  /** The canonical file-query identity, including the review target. */
  key: string
  load: () => Promise<void>
}

/**
 * Schedules the current visible range, followed by its prefetch range. Content
 * and deduplication across mounts remain in the review query cache. Replacing
 * the range drops unstarted work so a reversal does not drain an obsolete tail.
 */
export function createReviewContentQueue(input: {
  concurrency?: number
  onError: (request: ReviewContentRequest, error: unknown) => void
}) {
  const concurrency = input.concurrency ?? 4
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid review content concurrency")
  const active = new Set<string>()
  let pending = new Map<string, ReviewContentRequest>()
  let disposed = false
  let scheduled = false

  const drain = () => {
    scheduled = false
    if (disposed) return
    while (active.size < concurrency) {
      const next = pending.values().next().value
      if (!next) return
      pending.delete(next.key)
      active.add(next.key)
      void Promise.resolve().then(() => (disposed ? undefined : next.load())).catch((error: unknown) => {
        if (!disposed) input.onError(next, error)
      }).finally(() => {
        active.delete(next.key)
        drain()
      })
    }
  }

  return {
    /** Requests must be ordered visible-first. Empty input cancels queued work. */
    replace(requests: readonly ReviewContentRequest[]) {
      if (disposed) return
      pending = new Map()
      for (const request of requests) {
        if (!active.has(request.key) && !pending.has(request.key)) pending.set(request.key, request)
      }
      if (scheduled) return
      scheduled = true
      queueMicrotask(drain)
    },
    dispose() {
      disposed = true
      pending.clear()
    },
  }
}
