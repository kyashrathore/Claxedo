// Two keyed caches of disposable "live resources" (Solid reactive roots that
// own a terminal or prompt session) shared across provider instances. Kept as
// framework-free factories so the ref-counting/eviction/dispose-once rules can
// be exercised directly without mounting Solid. The caller supplies a
// `create()` that produces the value plus its dispose function (typically
// `createRoot`); the cache decides when that dispose runs.

/** A value paired with the function that tears down the reactive root owning it. */
export type DisposableResource<T> = {
  value: T
  dispose: () => void
}

/**
 * Reference-counted cache: multiple consumers can `acquire` the same key and
 * share one underlying resource; the resource is disposed exactly once, only
 * after every consumer has released it. When the cache grows past `max`,
 * currently-unreferenced entries are pruned (and disposed) oldest-first;
 * still-referenced entries are never evicted.
 */
export function createRefCountedResourceCache<T>(max: number) {
  type Entry = { value: T; dispose: () => void; refs: number }
  const cache = new Map<string, Entry>()

  const release = (key: string) => {
    const entry = cache.get(key)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return
    entry.dispose()
    cache.delete(key)
  }

  const prune = () => {
    if (cache.size <= max) return
    for (const [key, entry] of cache) {
      if (entry.refs > 0) continue
      entry.dispose()
      cache.delete(key)
      if (cache.size <= max) return
    }
  }

  const acquire = (key: string, create: () => DisposableResource<T>): { value: T; release: () => void } => {
    const existing = cache.get(key)
    if (existing) {
      existing.refs += 1
      return { value: existing.value, release: () => release(key) }
    }

    const created = create()
    cache.set(key, { value: created.value, dispose: created.dispose, refs: 1 })
    prune()
    return { value: created.value, release: () => release(key) }
  }

  return {
    acquire,
    has: (key: string) => cache.has(key),
    size: () => cache.size,
  }
}

/**
 * Least-recently-used cache: `load` returns a shared resource for a key,
 * creating it on a miss and moving it to the most-recently-used position on a
 * hit. When the cache grows past `max`, the least-recently-used entry is
 * evicted and disposed. There is no ref-counting — the newest `max` keys are
 * kept regardless of who is still reading them.
 */
export function createLruResourceCache<T>(max: number) {
  type Entry = { value: T; dispose: () => void }
  const cache = new Map<string, Entry>()

  const prune = () => {
    while (cache.size > max) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) return
      cache.get(oldest)?.dispose()
      cache.delete(oldest)
    }
  }

  const load = (key: string, create: () => DisposableResource<T>): T => {
    const existing = cache.get(key)
    if (existing) {
      // Re-insert to mark most-recently-used (Map preserves insertion order).
      cache.delete(key)
      cache.set(key, existing)
      return existing.value
    }

    const entry = create()
    cache.set(key, entry)
    prune()
    return entry.value
  }

  return {
    load,
    has: (key: string) => cache.has(key),
    size: () => cache.size,
  }
}
