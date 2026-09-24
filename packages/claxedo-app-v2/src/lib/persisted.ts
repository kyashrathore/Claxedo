import { makePersisted } from "@solid-primitives/storage"
import { createSignal, type Signal } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"

export type PreferenceReader<T> = (value: unknown) => T | undefined

export function preferenceKey(...parts: readonly string[]): string {
  return ["claxedo", ...parts].join(":")
}

function preferenceStorage(): Storage | undefined {
  return typeof localStorage === "object" ? localStorage : undefined
}

function deserializer<T>(key: string, read: PreferenceReader<T>, initial: T) {
  return (raw: string): T => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      console.warn(`Preference ${key} holds invalid JSON and starts fresh`, error)
      return initial
    }
    const value = read(parsed)
    if (value === undefined) {
      console.warn(`Preference ${key} holds an unexpected shape and starts fresh`, parsed)
      return initial
    }
    return value
  }
}

export function persistedSignal<T>(key: string, initial: T, read: PreferenceReader<T>): Signal<T> {
  const signal = createSignal<T>(initial)
  const storage = preferenceStorage()
  if (!storage) return signal
  const [get, set] = makePersisted<T, Signal<T>>(signal, {
    name: key,
    storage,
    deserialize: deserializer(key, read, initial),
  })
  return [get, set]
}

export function persistedStore<T extends object>(
  key: string,
  initial: T,
  read: PreferenceReader<T>,
): [Store<T>, SetStoreFunction<T>] {
  const store = createStore<T>(initial)
  const storage = preferenceStorage()
  if (!storage) return store
  const [get, set] = makePersisted<T, [Store<T>, SetStoreFunction<T>]>(store, {
    name: key,
    storage,
    deserialize: deserializer(key, read, initial),
  })
  return [get, set]
}
