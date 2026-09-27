export type ByteBoundedCache<K, V> = {
  peek(key: K): V | undefined
  get(key: K): V | undefined
  set(key: K, value: V): void
}

export function createByteBoundedCache<K, V>(
  limits: { readonly entries: number; readonly bytes: number },
  sizeOf: (key: K, value: V) => number,
): ByteBoundedCache<K, V> {
  const entries = new Map<K, { value: V; bytes: number }>()
  let totalBytes = 0

  const remove = (key: K) => {
    const entry = entries.get(key)
    if (!entry) return
    totalBytes -= entry.bytes
    entries.delete(key)
  }

  return {
    peek: (key) => entries.get(key)?.value,
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      const bytes = sizeOf(key, value)
      if (bytes > limits.bytes) return
      remove(key)
      entries.set(key, { value, bytes })
      totalBytes += bytes
      while (entries.size > limits.entries || totalBytes > limits.bytes) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        remove(oldest.value)
      }
    },
  }
}
