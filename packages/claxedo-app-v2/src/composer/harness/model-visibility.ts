import { produce } from "solid-js/store"
import { isRecord } from "@/lib/record"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import type { ModelChoice } from "@/server"
import { useModelPreferences } from "./context"

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

export function modelGroupKey(providerId: string, sampleModelId: string | undefined): string {
  const slash = sampleModelId?.indexOf("/") ?? -1
  return slash > 0 && sampleModelId ? `${providerId}/${sampleModelId.slice(0, slash)}` : providerId
}

const modelEntry = (model: ModelChoice) => `${model.providerId}:${model.modelId}`

export function resolveModelVisibility(input: { readonly model: ModelChoice; readonly defaults: Readonly<Record<string, string>>; readonly user?: Visibility; readonly group?: Visibility; readonly connected?: boolean }): boolean {
  if (input.user !== undefined) return input.user === "show"
  if (input.group !== undefined) return input.group === "show"
  if (input.connected === false) return false
  const fallback = input.defaults[input.model.providerId]
  return fallback === undefined || fallback === input.model.modelId
}

export type ModelVisibility = ReturnType<typeof createModelVisibility>

export function createModelVisibility() {
  const [store, setStore] = persistedStore<VisibilityRecord>(preferenceKey("model-visibility"), { entries: {}, groups: {} }, readVisibility)
  return {
    visible: (model: ModelChoice, context: ModelVisibilityContext = {}) =>
      resolveModelVisibility({
        model,
        defaults: context.defaults ?? {},
        ...(store.entries[modelEntry(model)] ? { user: store.entries[modelEntry(model)] } : {}),
        ...(context.group === undefined || !store.groups[context.group] ? {} : { group: store.groups[context.group] }),
        ...(context.connected === undefined ? {} : { connected: context.connected }),
      }),
    setVisibility: (model: ModelChoice, state: boolean) => setStore("entries", modelEntry(model), state ? "show" : "hide"),
    setGroupVisibility: (group: string, state: boolean, models: readonly ModelChoice[]) => {
      setStore("groups", group, state ? "show" : "hide")
      setStore(
        "entries",
        produce((entries) => {
          for (const model of models) delete entries[modelEntry(model)]
        }),
      )
    },
  }
}


export function useModelVisibility(): ModelVisibility {
  return useModelPreferences().visibility
}
