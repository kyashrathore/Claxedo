export class LRUMap<K, V> {
  private map = new Map<K, V>()

  constructor(private limit = 0) {}

  get size() {
    return this.map.size
  }

  get(key: K) {
    const value = this.map.get(key)
    if (value === undefined && !this.map.has(key)) return undefined
    this.map.delete(key)
    this.map.set(key, value as V)
    return value
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.limit > 0) {
      while (this.map.size > this.limit) this.shift()
    }
    return this
  }

  delete(key: K) {
    const value = this.map.get(key)
    if (value === undefined && !this.map.has(key)) return undefined
    this.map.delete(key)
    return value
  }

  clear() {
    this.map.clear()
  }

  shift() {
    const entry = this.map.entries().next()
    if (entry.done) return undefined
    this.map.delete(entry.value[0])
    return entry.value
  }

  has(key: K) {
    return this.map.has(key)
  }

  find(key: K) {
    return this.map.get(key)
  }

  keys() {
    return this.map.keys()
  }

  valuesIterator() {
    return this.map.values()
  }

  values() {
    return this.map.values()
  }

  entries() {
    return this.map.entries()
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  forEach(callback: (value: V, key: K, map: this) => void, thisArg?: unknown) {
    for (const [key, value] of this.map) callback.call(thisArg ?? this, value, key, this)
  }
}

export default { LRUMap }
