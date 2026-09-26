type Box<V> = { value: V }

export class LRUMap<K, V> {
  private map = new Map<K, Box<V>>()

  constructor(private limit = 0) {}

  get size() {
    return this.map.size
  }

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
