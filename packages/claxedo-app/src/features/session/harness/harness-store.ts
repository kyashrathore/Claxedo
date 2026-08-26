import { storePath } from "solid-js"

import { createStore } from "solid-js"
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
import { createStagedMap } from "@/lib/staged-reads"
import type { HarnessStorePatch, HarnessStoreState } from "./store-state"
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
  const initialByScope = new Map<string, HarnessStoreState>()

  const initialState = (scope: string) => {
    const existing = initialByScope.get(scope)
    if (existing) return existing
    const created = preferences.initialState(scope)
    initialByScope.set(scope, created)
    return created
  }

  // Same-task read-your-writes. Solid 2 stages store writes until the scheduler
  // flushes, but this facade is imperative and chains within one task
  // constantly: `seed` then `read`, `applyPatch` then `harness`, `promote` then
  // the submit selectors. The shared overlay in `@/lib/staged-reads` keeps those
  // reads honest; `read` touches the store first so reactive tracking through
  // `state`/`read` is unchanged.
  const staged = createStagedMap<HarnessStoreState>()

  /** Committed-or-staged entry for `scope`, or undefined if it has neither. */
  const entry = (scope: string) => staged.read(scope, store[scope])

  /** Stage the merged next state, then write the patch through to the store. */
  const write = (scope: string, patch: HarnessStorePatch | HarnessStoreState) => {
    staged.stage(scope, { ...read(scope), ...patch } as HarnessStoreState)
    setStore(storePath(scope, patch))
  }

  const seed = (scope: string) => {
    if (entry(scope)) return
    write(scope, initialState(scope))
    // The store owns the scope from here; drop the identity-stable pre-seed copy.
    initialByScope.delete(scope)
  }

  const read = (scope: string) => entry(scope) ?? initialState(scope)

  const touch = (scope: string) => {
    seed(scope)
    return read(scope)
  }

  const applyPatch = (scope: string, patch: HarnessStorePatch) => {
    seed(scope)
    write(scope, patch)
  }

  const save = (scope: string, key: PreferenceKey, value: string) => {
    preferences.save(scope, key, value)
  }

  const promote = (from: string, to: string) => {
    seed(from)
    write(to, {
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
    write(scope, {
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
      write(scope, {
        draftDefaultAuthority: "defaulted",
        draftDefaultState: "ready",
        optionsLoading: false,
        configError: undefined,
      })
    }
    return { application, saved }
  }

  const applyDraftDefault = (application: DraftDefaultApplication, input: Omit<ResolveDraftDefaultInput, "saved">) => {
    const current = read(application.scope)
    if (!shouldApplyDraftDefault(application, owner(application.scope))) return false
    const saved = current.draftDefault ?? { harness: "opencode" as const }
    const result = resolveDraftDefault({ ...input, saved })
    const model = result.model ?? result.blockedModel
    write(application.scope, {
      harness: result.harness,
      harnessMode: result.harness === "opencode" ? "opencode" : "harness",
      selectedModel: model?.modelID ?? "",
      selectedModelProvider: model?.providerID,
      optionsLoading: false,
      configError:
        result.state === "saved-model-unavailable"
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
    write(scope, {
      draftDefaultAuthority: "server",
      draftDefaultRevision: (read(scope).draftDefaultRevision ?? 0) + 1,
      draftDefault: undefined,
      draftDefaultState: undefined,
      draftDefaultWritePending: false,
      configError: undefined,
    })
  }

  const draftDefaultApplication = (scope: string, type: HarnessType) => {
    const current = read(scope)
    if (
      (current.draftDefaultAuthority ?? "unresolved") !== "unresolved" ||
      current.draftDefault?.harness !== type ||
      !current.draftDefaultWorkspaceKey
    )
      return undefined
    return {
      scope,
      workspaceKey: current.draftDefaultWorkspaceKey,
      revision: current.draftDefaultRevision ?? 0,
    }
  }

  const protectDraftModel = (scope: string) => {
    const current = read(scope)
    return (
      current.draftDefaultAuthority === "defaulted" ||
      (current.draftDefaultAuthority === "explicit" && !current.draftDefaultWritePending)
    )
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
    const liveConfigModel =
      !harnessHasConfigOptions(type) || !!current.dynamicModels?.some((item) => item.id === selected?.modelID)
    const model =
      selected && liveConfigModel && (type === "pi" || type === "opencode" || selected.providerID === type)
        ? selected
        : undefined
    const persisted = preferences.draftDefaults.save(identity, {
      harness: type,
      ...(model ? { model } : {}),
      ...(labels ? { labels } : {}),
    })
    write(scope, {
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
    write(scope, {
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
    const persisted = preferences.draftDefaults.save(identity, {
      harness: current.harness,
      model,
      ...(labels ? { labels } : {}),
    })
    write(scope, {
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
    )
      return false
    const persisted = preferences.draftDefaults.save(
      {
        serverUrl: current.draftDefaultServerUrl ?? "",
        workspaceKey: current.draftDefaultWorkspaceKey,
      },
      { harness: type, ...(model ? { model } : {}), ...(labels ? { labels } : {}) },
    )
    if (persisted) write(scope, { draftDefaultWritePending: false })
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
    state: (scope: string) => entry(scope),
    touch,
    setConfigError: (scope: string, message: string) => write(scope, { configError: message }),
    setOptionsLoading: (scope: string, value: boolean) => write(scope, { optionsLoading: value }),
    setReadiness: (scope: string, readiness: HarnessStoreState["readiness"]) => write(scope, { readiness }),
    setSelectedAgent: (scope: string, name: string) => write(scope, { selectedAgent: name }),
    setSelectedModel: (scope: string, model: ModelKey) => {
      write(scope, { selectedModel: model.modelID })
      write(scope, { selectedModelProvider: model.providerID })
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
    thoughtLevels: (scope: string) => read(scope).thoughtLevels ?? [],
    setThoughtLevel: (scope: string, value: string | undefined) => {
      // State only. The level reaches the harness on the NEXT PROMPT via
      // `harnessModelKeyForSubmit`'s `variant`, so there is nothing to push
      // here — the same reason opencode's variant setter is a local write.
      applyPatch(scope, { selectedThoughtLevel: value })
    },
    selectedThoughtLevel: (scope: string) => read(scope).selectedThoughtLevel,
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
