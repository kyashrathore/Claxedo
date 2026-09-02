import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import { harnessHasConfigOptions, type HarnessType } from "./profile"
import {
  harnessDisplayName,
  harnessModelKeyForSubmit,
  harnessModelNameForSubmit,
  harnessModels,
  harnessReadyForSubmit,
} from "./selection"
import {
  initialHarnessStoreState,
  type HarnessStorePatch,
  type HarnessStoreState,
} from "./store-state"
import {
  resolveDraftDefault,
  shouldApplyDraftDefault,
  type DraftDefaultApplication,
  type ResolveDraftDefaultInput,
} from "./draft-default-policy"
import {
  createDraftDefaultPreferences,
  type DraftDefaultLabels,
  type DraftDefaultScope,
} from "./draft-defaults"

export function createHarnessStore(storage: PanePreferenceStorage) {
  const [store, setStore] = createStore<Record<string, HarnessStoreState>>({})
  const draftDefaults = createDraftDefaultPreferences(storage)
  const initialByScope = new Map<string, HarnessStoreState>()

  const initialState = (scope: string) => {
    const existing = initialByScope.get(scope)
    if (existing) return existing
    const created = initialHarnessStoreState({ scope })
    initialByScope.set(scope, created)
    return created
  }

  const seed = (scope: string) => {
    if (store[scope]) return
    setStore(scope, initialState(scope))
    initialByScope.delete(scope)
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

  const promote = (from: string, to: string) => {
    seed(from)
    setStore(to, {
      ...read(from),
      draftDefaultAuthority: "server",
      draftDefaultRevision: (read(from).draftDefaultRevision ?? 0) + 1,
    })
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
    const saved = draftDefaults.read(identity)
    const type = saved?.harness ?? "opencode"
    setStore(scope, {
      draftDefaultAuthority: "unresolved",
      draftDefaultRevision: revision,
      draftDefaultServerUrl: identity.serverUrl,
      draftDefaultWorkspaceKey: identity.workspaceKey,
      draftDefault: saved,
      draftDefaultState: undefined,
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
      draftDefault: undefined,
      draftDefaultState: undefined,
      configError: undefined,
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

  /**
   * Whether a fresh options answer must keep this scope's model instead of
   * replacing it with the harness's own.
   *
   * Only a model the USER chose is held: `draftDefault.model` is the choice
   * this scope descends from, so it covers both a choice made here and one
   * restored from the workspace's memory, including the choice a shrunken
   * catalog no longer offers — that one has to stay selected for
   * "Saved model unavailable" to name it. A model the harness resolved is a
   * default, not a choice: every load may answer it afresh, and a catalog that
   * drops it simply resolves the next default rather than accusing the user of
   * selecting a model that is gone.
   */
  const protectDraftModel = (scope: string) => {
    const current = read(scope)
    const authority = current.draftDefaultAuthority
    return (authority === "defaulted" || authority === "explicit") && !!current.draftDefault?.model
  }

  /**
   * What it means for this draft to be on harness `type`: `type` plus the
   * choice `type` OWNS here, and nothing else.
   *
   * A harness switch is a choice of HARNESS, never of model. The live selection
   * belongs to the harness being left, and the model the incoming harness
   * resolves for itself is a default — so a harness the user has never picked a
   * model for carries no model, its draft state stays unsettled until the
   * options load resolves one, and the resolved default is shown afresh every
   * time rather than filed as something the user chose.
   */
  const draftHarnessChoicePatch = (
    scope: string,
    identity: Omit<DraftDefaultScope, "fallbackWorkspaceKey">,
    type: HarnessType,
  ) => {
    const current = read(scope)
    const choice = draftDefaults.readHarness(identity, type)
    return {
      choice,
      patch: {
        draftDefaultAuthority: "explicit",
        draftDefaultRevision: (current.draftDefaultRevision ?? 0) + 1,
        draftDefaultServerUrl: identity.serverUrl,
        draftDefaultWorkspaceKey: identity.workspaceKey,
        draftDefault: { harness: type, ...(choice ?? {}) },
        draftDefaultState: choice?.model || !harnessHasConfigOptions(type) ? "ready" : undefined,
        configError: undefined,
      } satisfies HarnessStorePatch,
    }
  }

  /** The user's switch to `type` landed: this workspace now opens drafts on it. */
  const rememberDraftHarness = (
    scope: string,
    identity: Omit<DraftDefaultScope, "fallbackWorkspaceKey">,
    type: HarnessType,
  ) => {
    seed(scope)
    const { choice, patch } = draftHarnessChoicePatch(scope, identity, type)
    const persisted = draftDefaults.save(identity, { harness: type, ...(choice ?? {}) })
    // The switch flow already put the selection where it belongs; only the
    // remembered pair is this call's business.
    setStore(scope, patch)
    return persisted
  }

  /**
   * The user picked `type` for this draft: restore what THAT harness last used
   * here. Each harness owns its own slot, so switching away and back returns to
   * the model it was on instead of "Choose a model".
   */
  const beginDraftHarnessChoice = (
    scope: string,
    identity: Omit<DraftDefaultScope, "fallbackWorkspaceKey">,
    type: HarnessType,
  ) => {
    seed(scope)
    const { choice, patch } = draftHarnessChoicePatch(scope, identity, type)
    setStore(scope, {
      ...patch,
      selectedModel: choice?.model?.modelID ?? "",
      selectedModelProvider: choice?.model?.providerID,
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
    const persisted = draftDefaults.save(identity, { harness: current.harness, model, ...(labels ? { labels } : {}) })
    setStore(scope, {
      draftDefaultAuthority: "explicit",
      draftDefaultRevision: (current.draftDefaultRevision ?? 0) + 1,
      draftDefaultServerUrl: identity.serverUrl,
      draftDefaultWorkspaceKey: identity.workspaceKey,
      draftDefault: { harness: current.harness, model, ...(labels ? { labels } : {}) },
      draftDefaultState: "ready",
      configError: undefined,
    })
    return persisted
  }

  const acceptsDraftModel = (scope: string, model: ModelKey) => canSelectDraftModel(read(scope), model)

  return {
    applyPatch,
    applyDraftDefault,
    beginDraftDefault,
    beginDraftHarnessChoice,
    acceptsDraftModel,
    draftDefaultApplication,
    protectDraftModel,
    promote,
    markServer,
    rememberDraftHarness,
    rememberDraftModel,
    read,
    seed,
    state: (scope: string) => store[scope],
    touch,
    setConfigError: (scope: string, message: string) => setStore(scope, "configError", message),
    setOptionsLoading: (scope: string, value: boolean) => setStore(scope, "optionsLoading", value),
    setReadiness: (scope: string, readiness: HarnessStoreState["readiness"]) => setStore(scope, "readiness", readiness),
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
    thoughtLevels: (scope: string) => read(scope).thoughtLevels ?? [],
    setThoughtLevel: (scope: string, value: string | undefined) => {
      // State only. The level reaches the harness on the NEXT PROMPT via
      // `harnessModelKeyForSubmit`'s `variant`, so there is nothing to push
      // here — the same reason opencode's variant setter is a local write.
      applyPatch(scope, { selectedThoughtLevel: value })
    },
    selectedThoughtLevel: (scope: string) => read(scope).selectedThoughtLevel,
    selectedModel: (scope: string) => read(scope).selectedModel ?? "",
    selectedModelKey: (scope: string) => harnessModelKeyForSubmit(read(scope)),
    optionsSource: (scope: string) => read(scope).optionsSource,
    optionsStale: (scope: string) => read(scope).optionsStale,
    optionsLoading: (scope: string) => read(scope).optionsLoading,
    configError: (scope: string) => read(scope).configError,
    draftDefaultState: (scope: string) => read(scope).draftDefaultState,
    draftDefaultLabels: (scope: string) => read(scope).draftDefault?.labels,
    draftDefaultModel: (scope: string) => read(scope).draftDefault?.model,
    draftDefaultAuthority: (scope: string) => read(scope).draftDefaultAuthority,
  }
}

function canSelectDraftModel(state: HarnessStoreState, model: ModelKey) {
  if (state.harness === "pi" || state.harness === "opencode") return true
  return model.providerID === state.harness && !!state.dynamicModels?.some((item) => item.id === model.modelID)
}
