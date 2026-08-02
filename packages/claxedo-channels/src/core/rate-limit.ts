/**
 * Per-sender inbound rate limiting. A bounded GLOBAL queue cannot distinguish
 * per-sender traffic, so one flooding sender evicts legitimate messages; the
 * limiter is therefore keyed per sender rather than shared.
 *
 * Two properties this depends on:
 *   - Abuse accounting is keyed on STABLE PRINCIPALS ONLY — (channel, sender).
 *     An attacker must not be able to reach a fresh bucket by changing the
 *     message type or forward semantics.
 *   - It runs AFTER the access gate (a blocked stranger never reaches here) but
 *     BEFORE dedup/session/LLM, so an ALLOWED-but-abusive sender still can't
 *     drive unbounded turns.
 *
 * Sliding-window counter, in-memory, LRU-capped so the limiter itself can't be
 * used to exhaust server memory.
 */
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number }

export type RateLimiter = {
  check(key: string, now?: number): RateLimitDecision
}

export type RateLimitOptions = {
  /** Max events permitted within the window. */
  limit: number
  /** Sliding window length in ms. */
  windowMs: number
  /** Max distinct keys tracked; oldest evicted past this (memory guard). */
  maxKeys?: number
}

export function createSlidingWindowRateLimiter(options: RateLimitOptions): RateLimiter {
  const limit = Math.max(1, options.limit)
  const windowMs = Math.max(1, options.windowMs)
  const maxKeys = Math.max(1, options.maxKeys ?? 10_000)
  // Insertion-ordered map → cheap LRU eviction from the front.
  const hits = new Map<string, number[]>()

  return {
    check(key, now = Date.now()) {
      const cutoff = now - windowMs
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff)
      if (recent.length >= limit) {
        // Oldest in-window event ages out at recent[0] + windowMs.
        const retryAfterMs = Math.max(1, recent[0] + windowMs - now)
        // Refresh recency without recording the rejected attempt.
        hits.delete(key)
        hits.set(key, recent)
        return { allowed: false, retryAfterMs }
      }
      recent.push(now)
      hits.delete(key)
      hits.set(key, recent)
      // Evict least-recently-touched keys past the cap.
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value
        if (oldest === undefined) break
        hits.delete(oldest)
      }
      return { allowed: true }
    },
  }
}

export function rateLimitKey(channel: string, externalUserId: string) {
  return `${channel}:${externalUserId}`
}
