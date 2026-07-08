import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import type { PanePreferenceStorage } from "../../pane/store/pane-preferences"
import { effectiveHarnessModel } from "../../session-client/harness/profile"
import {
  harnessDisplayName,
  harnessModelKeyForSubmit,
  harnessModelNameForSubmit,
  harnessModels,
  harnessReadyForSubmit,
} from "../../session-client/harness/selection"
import type {
  HarnessStorePatch,
  HarnessStoreState,
} from "../../session-client/harness/store-state"
import { createHarnessPreferences } from "./harness-preferences"

type PreferenceKey = "harness" | "model" | "agent"

export function createHarnessStore(storage: PanePreferenceStorage) {
  const [store, setStore] = createStore<Record<string, HarnessStoreState>>({})
  const preferences = createHarnessPreferences(storage)

  const initialState = (scope: string) => preferences.initialState(scope)

  const seed = (scope: string) => {
    if (store[scope]) return
    setStore(scope, initialState(scope))
  }

  const read = (scope: string) => store[scope] ?? initialState(scope)

  const touch = (scope: string) => {
    seed(scope)
    return store[scope]!
  }

  const applyPatch = (scope: string, patch: HarnessStorePatch) => {
    batch(() => {
      seed(scope)
      setStore(scope, patch)
    })
  }

  const save = (scope: string, key: PreferenceKey, value: string) => {
    preferences.save(scope, key, value)
  }

  const promote = (from: string, to: string) => {
    seed(from)
    setStore(to, { ...read(from) })
    preferences.promote(from, to)
  }

  return {
    applyPatch,
    promote,
    read,
    save,
    seed,
    state: (scope: string) => store[scope],
    touch,
    setConfigError: (scope: string, message: string) => setStore(scope, "configError", message),
    setOptionsLoading: (scope: string, value: boolean) => setStore(scope, "optionsLoading", value),
    setReadiness: (scope: string, readiness: HarnessStoreState["readiness"]) => setStore(scope, "readiness", readiness),
    setSelectedAgent: (scope: string, name: string) => setStore(scope, "selectedAgent", name),
    setSelectedModel: (scope: string, model: string) => setStore(scope, "selectedModel", model),
    displayName: (scope: string) => harnessDisplayName(read(scope)),
    harness: (scope: string) => read(scope).harness,
    harnessBinary: (scope: string) => read(scope).harnessBinary,
    harnessMode: (scope: string) => read(scope).harnessMode,
    harnessModelKeyForSubmit: (scope: string) => harnessModelKeyForSubmit(read(scope)),
    harnessModelNameForSubmit: (scope: string) => harnessModelNameForSubmit(read(scope)),
    harnessReadyForSubmit: (scope: string) => harnessReadyForSubmit(read(scope)),
    isHarnessMode: (scope: string) => read(scope).harness !== "opencode",
    models: (scope: string) => harnessModels(read(scope)),
    selectedAgent: (scope: string) => read(scope).selectedAgent,
    selectedModel: (scope: string) => effectiveHarnessModel(read(scope).harness, read(scope).selectedModel),
    optionsSource: (scope: string) => read(scope).optionsSource,
    optionsStale: (scope: string) => read(scope).optionsStale,
    optionsLoading: (scope: string) => read(scope).optionsLoading,
    configError: (scope: string) => read(scope).configError,
  }
}
