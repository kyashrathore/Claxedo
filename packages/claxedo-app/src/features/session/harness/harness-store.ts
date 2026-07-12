import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import { effectiveHarnessModel, harnessHasConfigOptions, type HarnessType } from "./profile"
import {
  harnessDisplayName,
  harnessModelKeyForSubmit,
  harnessModelNameForSubmit,
  harnessModels,
  harnessReadyForSubmit,
} from "./selection"
import type {
  HarnessStorePatch,
  HarnessStoreState,
} from "./store-state"
import { createHarnessPreferences } from "./harness-preferences"
import {
  resolveDraftDefault,
  shouldApplyDraftDefault,
  type DraftDefaultApplication,
  type ResolveDraftDefaultInput,
} from "./draft-default-policy"
import type { DraftDefaultLabels, DraftDefaultScope } from "./draft-defaults"

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
    setStore(to, {
      ...read(from),
      draftDefaultAuthority: "server",
      draftDefaultRevision: (read(from).draftDefaultRevision ?? 0) + 1,
      draftDefaultWritePending: false,
    })
    preferences.promote(from, to)
  }

  const owner = (scope: string) => {
    const state = read(scope)
    return {
      authority: state.draftDefaultAuthority ?? (scope.startsWith("session:") ? "server" : "unresolved"),
      revision: state.draftDefaultRevision ?? 0,
      scope,
      workspaceKey: state.draftDefaultWorkspaceKey ?? "",
    }
  }

  const beginDraftDefault = (scope: string, identity: DraftDefaultScope) => {
    seed(scope)
    const current = read(scope)
    if (current.draftDefaultAuthority === "server") return undefined
    if (current.draftDefaultWorkspaceKey === identity.workspaceKey) {
      return { application: owner(scope), saved: current.draftDefault }
    }

    const revision = (current.draftDefaultRevision ?? 0) + 1
    const saved = preferences.draftDefaults.read(identity)
    const type = saved?.harness ?? "opencode"
    setStore(scope, {
      draftDefaultAuthority: "unresolved",
      draftDefaultRevision: revision,
      draftDefaultServerUrl: identity.serverUrl,
      draftDefaultWorkspaceKey: identity.workspaceKey,
      draftDefault: saved,
      draftDefaultState: undefined,
      draftDefaultWritePending: false,
      harness: type,
      harnessMode: type === "opencode" ? "opencode" : "harness",
      selectedModel: saved?.model?.modelID ?? "",
      selectedModelProvider: saved?.model?.providerID,
      optionsLoading: !!saved && harnessHasConfigOptions(type),
      configError: saved ? "Loading model options..." : undefined,
    })
    const application = { scope, workspaceKey: identity.workspaceKey, revision }
    if (!saved) {
      setStore(scope, {
        draftDefaultAuthority: "defaulted",
        draftDefaultState: "ready",
        optionsLoading: false,
        configError: undefined,
      })
    }
    return { application, saved }
  }

  const applyDraftDefault = (
    application: DraftDefaultApplication,
    input: Omit<ResolveDraftDefaultInput, "saved">,
  ) => {
    const current = read(application.scope)
    if (!shouldApplyDraftDefault(application, owner(application.scope))) return false
    const saved = current.draftDefault ?? { harness: "opencode" as const }
    const result = resolveDraftDefault({ ...input, saved })
    const model = result.model ?? result.blockedModel
    setStore(application.scope, {
      harness: result.harness,
      harnessMode: result.harness === "opencode" ? "opencode" : "harness",
      selectedModel: model?.modelID ?? "",
      selectedModelProvider: model?.providerID,
      optionsLoading: false,
      configError: result.state === "saved-model-unavailable"
        ? "Saved model unavailable"
        : result.state === "choose-model"
          ? "Choose a model"
          : undefined,
      draftDefaultAuthority: "defaulted",
      draftDefaultState: result.state,
    })
    return true
  }

  const markServer = (scope: string) => {
    seed(scope)
    setStore(scope, {
      draftDefaultAuthority: "server",
      draftDefaultRevision: (read(scope).draftDefaultRevision ?? 0) + 1,
      draftDefaultWritePending: false,
    })
  }

  const draftDefaultApplication = (scope: string, type: HarnessType) => {
    const current = read(scope)
    if (
      (current.draftDefaultAuthority ?? "unresolved") !== "unresolved" ||
      current.draftDefault?.harness !== type ||
      !current.draftDefaultWorkspaceKey
    ) return undefined
    return {
      scope,
      workspaceKey: current.draftDefaultWorkspaceKey,
      revision: current.draftDefaultRevision ?? 0,
    }
  }

  const protectDraftModel = (scope: string) => {
    const current = read(scope)
    return current.draftDefaultAuthority === "defaulted" ||
      (current.draftDefaultAuthority === "explicit" && !current.draftDefaultWritePending)
  }

  const rememberDraftHarness = (
    scope: string,
    identity: Omit<DraftDefaultScope, "fallbackWorkspaceKey">,
    type: HarnessType,
    labels?: DraftDefaultLabels,
  ) => {
    seed(scope)
    const current = read(scope)
    const revision = (current.draftDefaultRevision ?? 0) + 1
    const selected = harnessModelKeyForSubmit(current)
    const liveConfigModel = !harnessHasConfigOptions(type) ||
      !!current.dynamicModels?.some((item) => item.id === selected?.modelID)
    const model = selected && liveConfigModel &&
      (type === "pi" || type === "opencode" || selected.providerID === type)
      ? selected
      : undefined
    const persisted = preferences.draftDefaults.save(identity, { harness: type, ...(model ? { model } : {}), ...(labels ? { labels } : {}) })
    setStore(scope, {
      draftDefaultAuthority: "explicit",
      draftDefaultRevision: revision,
      draftDefaultServerUrl: identity.serverUrl,
      draftDefaultWorkspaceKey: identity.workspaceKey,
      draftDefault: { version: 1, harness: type, ...(model ? { model } : {}), ...(labels ? { labels } : {}) },
      draftDefaultState: model || !harnessHasConfigOptions(type) ? "ready" : undefined,
      draftDefaultWritePending: harnessHasConfigOptions(type) && !model,
      configError: undefined,
    })
    return persisted
  }

  const beginDraftHarnessChoice = (
    scope: string,
    identity: Omit<DraftDefaultScope, "fallbackWorkspaceKey">,
    type: HarnessType,
  ) => {
    seed(scope)
    const current = read(scope)
    setStore(scope, {
      draftDefaultAuthority: "explicit",
      draftDefaultRevision: (current.draftDefaultRevision ?? 0) + 1,
      draftDefaultServerUrl: identity.serverUrl,
      draftDefaultWorkspaceKey: identity.workspaceKey,
      draftDefault: { version: 1, harness: type },
      draftDefaultState: undefined,
      draftDefaultWritePending: harnessHasConfigOptions(type),
      configError: undefined,
    })
  }

  const rememberDraftModel = (
    scope: string,
    identity: Omit<DraftDefaultScope, "fallbackWorkspaceKey">,
    model: ModelKey,
    labels?: DraftDefaultLabels,
  ) => {
    seed(scope)
    const current = read(scope)
    if (!canSelectDraftModel(current, model)) return false
    const persisted = preferences.draftDefaults.save(identity, { harness: current.harness, model, ...(labels ? { labels } : {}) })
    setStore(scope, {
      draftDefaultAuthority: "explicit",
      draftDefaultRevision: (current.draftDefaultRevision ?? 0) + 1,
      draftDefaultServerUrl: identity.serverUrl,
      draftDefaultWorkspaceKey: identity.workspaceKey,
      draftDefault: { version: 1, harness: current.harness, model, ...(labels ? { labels } : {}) },
      draftDefaultState: "ready",
      draftDefaultWritePending: false,
      configError: undefined,
    })
    return persisted
  }

  const acceptsDraftModel = (scope: string, model: ModelKey) => canSelectDraftModel(read(scope), model)

  const completeRememberedHarness = (
    scope: string,
    type: HarnessType,
    model?: ModelKey,
    labels?: DraftDefaultLabels,
  ) => {
    const current = read(scope)
    if (
      current.draftDefaultAuthority !== "explicit" ||
      !current.draftDefaultWritePending ||
      current.harness !== type ||
      !current.draftDefaultWorkspaceKey
    ) return false
    const persisted = preferences.draftDefaults.save({
      serverUrl: current.draftDefaultServerUrl ?? "",
      workspaceKey: current.draftDefaultWorkspaceKey,
    }, { harness: type, ...(model ? { model } : {}), ...(labels ? { labels } : {}) })
    if (persisted) setStore(scope, "draftDefaultWritePending", false)
    return persisted
  }

  return {
    applyPatch,
    applyDraftDefault,
    beginDraftDefault,
    beginDraftHarnessChoice,
    acceptsDraftModel,
    completeRememberedHarness,
    draftDefaultApplication,
    protectDraftModel,
    promote,
    markServer,
    rememberDraftHarness,
    rememberDraftModel,
    read,
    save,
    seed,
    state: (scope: string) => store[scope],
    touch,
    setConfigError: (scope: string, message: string) => setStore(scope, "configError", message),
    setOptionsLoading: (scope: string, value: boolean) => setStore(scope, "optionsLoading", value),
    setReadiness: (scope: string, readiness: HarnessStoreState["readiness"]) => setStore(scope, "readiness", readiness),
    setSelectedAgent: (scope: string, name: string) => setStore(scope, "selectedAgent", name),
    setSelectedModel: (scope: string, model: ModelKey) => {
      setStore(scope, "selectedModel", model.modelID)
      setStore(scope, "selectedModelProvider", model.providerID)
    },
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
    selectedModelKey: (scope: string) => harnessModelKeyForSubmit(read(scope)),
    optionsSource: (scope: string) => read(scope).optionsSource,
    optionsStale: (scope: string) => read(scope).optionsStale,
    optionsLoading: (scope: string) => read(scope).optionsLoading,
    configError: (scope: string) => read(scope).configError,
    draftDefaultState: (scope: string) => read(scope).draftDefaultState,
    draftDefaultLabels: (scope: string) => read(scope).draftDefault?.labels,
    draftDefaultModel: (scope: string) => read(scope).draftDefault?.model,
  }
}

function canSelectDraftModel(state: HarnessStoreState, model: ModelKey) {
  if (state.harness === "pi" || state.harness === "opencode") return true
  return model.providerID === state.harness && !!state.dynamicModels?.some((item) => item.id === model.modelID)
}
