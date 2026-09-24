import { createRoot } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { isRecord } from "@/lib/record"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import type { ModelRef } from "./model-visibility"

type NameRecord = Record<string, string>

function readNames(value: unknown): NameRecord | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

let shared: [Store<NameRecord>, SetStoreFunction<NameRecord>] | undefined

function namesStore() {
  shared ??= createRoot(() => persistedStore<NameRecord>(preferenceKey("model-names"), {}, readNames))
  return shared
}

const nameKey = (model: ModelRef) => `${model.providerId}:${model.modelId}`

export function useModelNames() {
  const [store, setStore] = namesStore()
  return {
    name: (model: ModelRef): string | undefined => store[nameKey(model)],
    remember: (model: ModelRef, name: string) => {
      if (store[nameKey(model)] !== name) setStore(nameKey(model), name)
    },
  }
}
