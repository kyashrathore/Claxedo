import { makePersisted, type PersistenceOptions } from "@solid-primitives/storage"
import { createSignal, type Signal } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"

export type PreferenceReader<T> = (value: unknown) => T | undefined

export function preferenceKey(...parts: readonly string[]): string {
  return ["claxedo", ...parts].join(":")
}

function preferenceStorage(): Storage | undefined {
  return typeof localStorage === "object" ? localStorage : undefined
}

export function tabStorage(): Storage | undefined {
  return typeof sessionStorage === "object" ? sessionStorage : undefined
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

function persistence<T>(key: string, storage: Storage, read: PreferenceReader<T>, initial: T): PersistenceOptions<T, undefined> {
  return { name: key, storage, deserialize: deserializer(key, read, initial) }
}

export function persistedSignal<T>(
  key: string,
  initial: T,
  read: PreferenceReader<T>,
  storage: Storage | undefined = preferenceStorage(),
): Signal<T> {
  const signal = createSignal(initial)
  if (!storage) return signal
  const [get, set] = makePersisted(signal, persistence(key, storage, read, initial))
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
  const [get, set] = makePersisted(store, persistence(key, storage, read, initial))
  return [get, set]
}
