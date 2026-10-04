import { produce } from "solid-js/store"
import { isRecord } from "@claxedo/helpers/guards"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import type { ModelChoice } from "@/server"
import { useModelPreferences } from "./context"

type NameRecord = Record<string, string>

const NAME_LIMIT = 100

function readNames(value: unknown): NameRecord | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

const nameKey = (model: ModelChoice) => `${model.providerId}:${model.modelId}`

export type ModelNames = {
  readonly name: (model: ModelChoice) => string | undefined
  readonly remember: (model: ModelChoice, name: string) => void
}

export function createModelNames(): ModelNames {
  const [store, setStore] = persistedStore<NameRecord>(preferenceKey("model-names"), {}, readNames)
  return {
    name: (model: ModelChoice): string | undefined => store[nameKey(model)],
    remember: (model: ModelChoice, name: string) => {
      const key = nameKey(model)
      if (store[key] === name && Object.keys(store).at(-1) === key) return
      setStore(
        produce((names) => {
          delete names[key]
          names[key] = name
          for (const stale of Object.keys(names).slice(0, -NAME_LIMIT)) delete names[stale]
        }),
      )
    },
  }
}

export function useModelNames(): ModelNames {
  return useModelPreferences().names
}
