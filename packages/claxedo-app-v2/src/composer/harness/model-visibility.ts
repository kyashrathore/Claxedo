import { createRoot } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { isRecord } from "@/lib/record"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import type { ModelKey } from "./model-key"

type Visibility = "show" | "hide"

type VisibilityRecord = { entries: Record<string, Visibility>; groups: Record<string, Visibility> }

export type ModelVisibilityContext = { readonly defaults?: Readonly<Record<string, string>>; readonly group?: string; readonly connected?: boolean }

function visibilityMap(value: unknown): Record<string, Visibility> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Visibility] => entry[1] === "show" || entry[1] === "hide"))
}

function readVisibility(value: unknown): VisibilityRecord | undefined {
  return isRecord(value) ? { entries: visibilityMap(value.entries), groups: visibilityMap(value.groups) } : undefined
}

const modelEntry = (model: ModelKey) => `${model.providerID}:${model.modelID}`

let shared: [Store<VisibilityRecord>, SetStoreFunction<VisibilityRecord>] | undefined

function visibilityStore() {
  shared ??= createRoot(() => persistedStore<VisibilityRecord>(preferenceKey("model-visibility"), { entries: {}, groups: {} }, readVisibility))
  return shared
}

export function resolveModelVisibility(input: { readonly model: ModelKey; readonly defaults: Readonly<Record<string, string>>; readonly user?: Visibility; readonly group?: Visibility; readonly connected?: boolean }): boolean {
  if (input.user !== undefined) return input.user === "show"
  if (input.group !== undefined) return input.group === "show"
  if (input.connected === false) return false
  const fallback = input.defaults[input.model.providerID]
  return fallback === undefined || fallback === input.model.modelID
}

export function useModelVisibility() {
  const [store, setStore] = visibilityStore()
  return {
    visible: (model: ModelKey, context: ModelVisibilityContext = {}) =>
      resolveModelVisibility({
        model,
        defaults: context.defaults ?? {},
        ...(store.entries[modelEntry(model)] ? { user: store.entries[modelEntry(model)] } : {}),
        ...(context.group === undefined || !store.groups[context.group] ? {} : { group: store.groups[context.group] }),
        ...(context.connected === undefined ? {} : { connected: context.connected }),
      }),
    setVisibility: (model: ModelKey, state: boolean) => setStore("entries", modelEntry(model), state ? "show" : "hide"),
    setGroupVisibility: (group: string, state: boolean, models: readonly ModelKey[]) => {
      setStore("groups", group, state ? "show" : "hide")
      setStore("entries", (entries) => {
        const next = { ...entries }
        for (const model of models) delete next[modelEntry(model)]
        return next
      })
    },
  }
}

export type ModelVisibility = ReturnType<typeof useModelVisibility>
