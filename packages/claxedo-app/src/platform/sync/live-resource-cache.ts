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
 * Reference-counted LRU: the RETENTION of `createLruResourceCache` plus the
 * LIVENESS guarantee of `createRefCountedResourceCache`.
 *
 * `acquire` pins an entry for as long as its handle is held, so a resource whose
 * consumer is still mounted can never be evicted. `release` does NOT dispose —
 * it only un-pins, leaving the entry cached and reusable, so leaving a resource
 * and coming back keeps the same live value AND the same object identity.
 * Eviction happens only under cap pressure, oldest-first, and skips pinned
 * entries; that is the only place `dispose` runs, and it runs at most once.
 *
 * Neither sibling can express that on its own:
 *   - `createRefCountedResourceCache` disposes at zero refs, so it retains
 *     nothing — an unmounted resource is destroyed the instant its last consumer
 *     lets go, which for a draft cache throws the draft away.
 *   - `createLruResourceCache` has no idea who is still reading, so `max` newer
 *     keys dispose a reactive root a mounted consumer is still subscribed to.
 *
 * The cost, stated plainly: `max` bounds RETENTION, not total live resources. If
 * more than `max` consumers are mounted at once the cache exceeds `max` rather
 * than disposing something in use, and shrinks back as they release. That is only
 * safe where concurrent consumers are bounded by something small (mounted panes),
 * not by history (every key ever visited).
 */
export function createRefCountedLruResourceCache<T>(max: number) {
  type Entry = { value: T; dispose: () => void; refs: number; disposed: boolean }
  const cache = new Map<string, Entry>()

  const disposeOnce = (entry: Entry) => {
    if (entry.disposed) return
    entry.disposed = true
    entry.dispose()
  }

  /** Oldest-first over UNPINNED entries only; pinned entries keep their place. */
  const prune = () => {
    if (cache.size <= max) return
    for (const [key, entry] of cache) {
      if (entry.refs > 0) continue
      cache.delete(key)
      disposeOnce(entry)
      if (cache.size <= max) return
    }
  }

  const acquire = (key: string, create: () => DisposableResource<T>): { value: T; release: () => void } => {
    let entry = cache.get(key)
    if (entry) {
      // Re-insert to mark most-recently-used (Map preserves insertion order).
      cache.delete(key)
      cache.set(key, entry)
      entry.refs += 1
    } else {
      const created = create()
      entry = { value: created.value, dispose: created.dispose, refs: 1, disposed: false }
      cache.set(key, entry)
      // Pinned at refs=1 before pruning, so a brand-new entry is never the one
      // evicted to make room for itself.
      prune()
    }

    const pinned = entry
    let released = false
    return {
      value: pinned.value,
      // Idempotent, and bound to THIS entry object rather than to the key alone:
      // a double release must not drive a count negative, nor decrement a later
      // entry that has since reused the key.
      release: () => {
        if (released) return
        released = true
        pinned.refs -= 1
        if (pinned.refs === 0) prune()
      },
    }
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
 *
 * NO PRODUCTION CONSUMER since prompt.tsx moved to `createRefCountedLruResourceCache`.
 * Do not reach for this for anything whose `dispose` tears down state a mounted
 * consumer is subscribed to (a Solid root, a socket, a PTY): `max` newer keys will
 * dispose it underneath that consumer. It is only safe for values that can be
 * dropped and rebuilt at any moment, with no live reader.
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
