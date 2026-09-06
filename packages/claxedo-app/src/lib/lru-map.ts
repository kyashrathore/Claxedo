/**
 * Insertion-ordered map with a most-recently-used eviction bound, exposing the
 * surface of the `lru_map` npm package (the vite configs alias the bare
 * `lru_map` specifier here).
 *
 * Values live in a one-field box, the same shape `scoped-cache.ts` uses. A bare
 * `Map<K, V>` cannot express "this key is present" when `V` itself includes
 * `undefined`, which forced every read to re-check `has` and then assert the
 * value back to `V`; boxing makes presence a fact the type system can see, so
 * no read needs an assertion.
 */
type Box<V> = { value: V }

export class LRUMap<K, V> {
  private map = new Map<K, Box<V>>()

  constructor(private limit = 0) {}

  get size() {
    return this.map.size
  }

  /** Read `key` and mark it most-recently-used. */
  get(key: K): V | undefined {
    const box = this.map.get(key)
    if (!box) return undefined
    this.map.delete(key)
    this.map.set(key, box)
    return box.value
  }

  set(key: K, value: V): this {
    this.map.delete(key)
    this.map.set(key, { value })
    if (this.limit > 0) {
      while (this.map.size > this.limit) this.shift()
    }
    return this
  }

  delete(key: K): V | undefined {
    const box = this.map.get(key)
    if (!box) return undefined
    this.map.delete(key)
    return box.value
  }

  clear() {
    this.map.clear()
  }

  /** Evict the least-recently-used entry and return it. */
  shift(): [K, V] | undefined {
    const oldest = this.map.entries().next()
    if (oldest.done) return undefined
    const [key, box] = oldest.value
    this.map.delete(key)
    return [key, box.value]
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  /** Read `key` without changing its recency. */
  find(key: K): V | undefined {
    return this.map.get(key)?.value
  }

  keys(): IterableIterator<K> {
    return this.map.keys()
  }

  *valuesIterator(): IterableIterator<V> {
    for (const box of this.map.values()) yield box.value
  }

  values(): IterableIterator<V> {
    return this.valuesIterator()
  }

  *entries(): IterableIterator<[K, V]> {
    for (const [key, box] of this.map) yield [key, box.value]
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  forEach(callback: (value: V, key: K, map: this) => void, thisArg?: unknown) {
    for (const [key, box] of this.map) callback.call(thisArg ?? this, box.value, key, this)
  }
}

export default { LRUMap }
