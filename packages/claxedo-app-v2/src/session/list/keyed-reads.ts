import { createComputed, createSignal, getListener, onCleanup, type Accessor, type Setter } from "solid-js"

type Reader<V> = { readonly read: Accessor<V | undefined>; readonly write: Setter<V | undefined>; readers: number }

export function createKeyedReads<K, V>(source: Accessor<ReadonlyMap<K, V>>): (key: K) => V | undefined {
  const readers = new Map<K, Reader<V>>()
  let current: ReadonlyMap<K, V> = new Map()
  createComputed(() => {
    current = source()
    for (const [key, reader] of readers) reader.write(() => current.get(key))
  })
  const readerOf = (key: K) => {
    const known = readers.get(key)
    if (known) return known
    const [read, write] = createSignal<V | undefined>(current.get(key))
    const created: Reader<V> = { read, write, readers: 0 }
    readers.set(key, created)
    return created
  }
  return (key) => {
    if (!getListener()) return current.get(key)
    const reader = readerOf(key)
    reader.readers += 1
    onCleanup(() => {
      reader.readers -= 1
      if (reader.readers === 0 && readers.get(key) === reader) readers.delete(key)
    })
    return reader.read()
  }
}
