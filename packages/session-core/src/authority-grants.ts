export type AuthorityGrant = { allowed: true; lease?: string; expiresAt?: number }

export type AuthorityGrants = {
  held(key: string): AuthorityGrant | undefined
  /**
   * `askedAt` is the generation read before the question went out: an answer
   * to a question asked before a `forget` is dropped, so a revocation ring
   * that lands while the question is in flight is not undone by its answer.
   */
  hold(key: string, grant: AuthorityGrant, ttlMs: number, askedAt: number): void
  generation(): number
  forget(): void
  onForget(listener: () => void): () => void
}

/** The longest a host reuses an answer, whatever the answer says. */
export const AUTHORITY_GRANT_MAX_TTL_MS = 60_000

const DEFAULT_CAPACITY = 1_024

export function createAuthorityGrants(options: { now?: () => number; capacity?: number } = {}): AuthorityGrants {
  const now = options.now ?? Date.now
  const capacity = options.capacity ?? DEFAULT_CAPACITY
  const entries = new Map<string, { grant: AuthorityGrant; until: number }>()
  const listeners = new Set<() => void>()
  let generation = 0
  return {
    held(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.until <= now()) {
        entries.delete(key)
        return undefined
      }
      return entry.grant
    },
    hold(key, grant, ttlMs, askedAt) {
      if (askedAt !== generation || !Number.isFinite(ttlMs) || ttlMs <= 0) return
      entries.delete(key)
      if (entries.size >= capacity) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      entries.set(key, { grant, until: now() + Math.min(ttlMs, AUTHORITY_GRANT_MAX_TTL_MS) })
    },
    generation: () => generation,
    forget() {
      generation += 1
      entries.clear()
      for (const listener of listeners) listener()
    },
    onForget(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
