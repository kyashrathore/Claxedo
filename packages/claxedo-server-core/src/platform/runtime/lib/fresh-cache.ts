export type FreshCache<K, V> = {
  read(key: K, options?: { fresh?: boolean }): Promise<V>
}

/**
 * One read per key at a time, and its answer for `freshForMs` after.
 *
 * A read already in flight is joined even by a `fresh` caller: it was started
 * no earlier than this call, so its answer is as new as one started now, and a
 * second read of the same key buys nothing. A read that rejects is not
 * remembered, so the next caller asks again rather than inheriting the failure.
 */
export function createFreshCache<K, V>(input: {
  read: (key: K, options: { fresh: boolean }) => Promise<V>
  freshForMs: number
  now?: () => number
}): FreshCache<K, V> {
  // Looked up per call: a cache built at module load would otherwise keep the
  // `Date.now` that fake timers later replace.
  const now = input.now ?? (() => Date.now())
  const answers = new Map<K, { at: number; value: V }>()
  const asking = new Map<K, Promise<V>>()
  return {
    read(key, options = {}) {
      const fresh = options.fresh === true
      const held = answers.get(key)
      if (!fresh && held && now() - held.at < input.freshForMs) return Promise.resolve(held.value)
      const inFlight = asking.get(key)
      if (inFlight) return inFlight
      const started = input.read(key, { fresh })
        .then((value) => {
          answers.set(key, { at: now(), value })
          return value
        })
        .finally(() => asking.delete(key))
      asking.set(key, started)
      return started
    },
  }
}
