export type RateLimitResult = {
  allowed: true
} | {
  allowed: false
  retryAfterMs: number
  /**
   * True only for the FIRST rejection in the current window. Callers use this
   * to audit a flood once per window instead of amplifying every rejected
   * request into an audit write.
   */
  firstRejection?: boolean
}

export type ConnectionRateLimiter = {
  check(input: {
    userId: string
    workspaceId: string
  }): RateLimitResult
  /**
   * Return one unit of budget for a request that did not actually consume the
   * limited resource (e.g. a provisioning poll that never minted a token).
   */
  refund?(input: {
    userId: string
    workspaceId: string
  }): void
  /** Number of live buckets (expired buckets are evicted). Observability/tests. */
  size?(): number
}

export function createFixedWindowConnectionRateLimiter(options: {
  limit?: number
  windowMs?: number
  now?: () => number
} = {}): ConnectionRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number; rejections?: number }>()
  const limit = Math.max(1, options.limit ?? 6)
  const windowMs = Math.max(1, options.windowMs ?? 60_000)
  const now = options.now ?? Date.now
  let nextSweepAt = 0

  function evictExpired(timestamp: number) {
    if (timestamp < nextSweepAt) return
    nextSweepAt = timestamp + windowMs
    for (const [key, bucket] of buckets) {
      if (timestamp >= bucket.resetAt) buckets.delete(key)
    }
  }

  return {
    check(input) {
      const key = `${input.userId}:${input.workspaceId}`
      const timestamp = now()
      evictExpired(timestamp)
      const current = buckets.get(key)
      if (!current || timestamp >= current.resetAt) {
        buckets.set(key, { count: 1, resetAt: timestamp + windowMs })
        return { allowed: true }
      }
      if (current.count >= limit) {
        current.rejections = (current.rejections ?? 0) + 1
        return {
          allowed: false,
          retryAfterMs: current.resetAt - timestamp,
          firstRejection: current.rejections === 1,
        }
      }
      current.count += 1
      return { allowed: true }
    },
    refund(input) {
      const key = `${input.userId}:${input.workspaceId}`
      const current = buckets.get(key)
      if (!current || now() >= current.resetAt) return
      if (current.count > 0) current.count -= 1
    },
    size() {
      return buckets.size
    },
  }
}
