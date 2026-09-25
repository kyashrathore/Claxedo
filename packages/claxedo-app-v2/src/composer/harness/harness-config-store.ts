import type { HarnessOptions, ModelChoice, Server } from "@/server"
import { createHarnessConnectionsCatalog } from "./connection-catalog"
import { createHarnessOptionsLoader, type HarnessOptionsLoaderCache } from "./harness-options-loader"
import { createHarnessHydrator, type HarnessHydratorCache } from "./harness-hydrator"
import { createHarnessSwitcher, type HarnessSwitcherCache } from "./harness-switcher"
import { createHarnessModelWriter, type HarnessSessionModelSyncCache, type SessionModelSyncState } from "./harness-model-writer"
import { createHarnessStore } from "./harness-store"
import { createHarnessStatusActions } from "./harness-status-actions"
import type { HarnessScopeInput } from "./store-policy"
import { harnessHasConfigOptions, harnessSelectionId, isCatalogHarness } from "./profile"
import { harnessHealthReadiness } from "./store-state"
import type { HarnessType } from "./profile"
import type { DraftDefaultLabels, DraftDefaultStorage } from "./draft-defaults"
import type { ResolveDraftDefaultInput } from "./draft-default-policy"

type ScopeInput = HarnessScopeInput

function pendingSlots<Value>() {
  const slots = new Map<string, Value>()
  return {
    get: (key: string) => slots.get(key),
    set: (key: string, value: Value) => void slots.set(key, value),
    remove: (key: string, value: Value) => {
      if (slots.get(key) === value) slots.delete(key)
    },
  }
}

function createScopeCaches() {
  const seq = new Map<string, number>()
  const tries = new Map<string, number>()
  const seen = new Map<string, string>()
  const hydrations = pendingSlots<Promise<void>>()
  const switches = pendingSlots<Promise<void>>()
  const syncStates = new Map<string, SessionModelSyncState>()
  const syncs = pendingSlots<Promise<void>>()
  const options: HarnessOptionsLoaderCache = {
    nextSeq: (scope) => {
      const next = (seq.get(scope) ?? 0) + 1
      seq.set(scope, next)
      return next
    },
    getSeq: (scope) => seq.get(scope),
    getTries: (scope) => tries.get(scope),
    setTries: (scope, value) => void tries.set(scope, value),
    clearTries: (scope) => void tries.delete(scope),
  }
  const hydrator: HarnessHydratorCache<ScopeInput> = {
    getSeen: (scope) => seen.get(scope),
    setSeen: (scope, key) => void seen.set(scope, key),
    clearSeen: (scope) => void seen.delete(scope),
    getPending: hydrations.get,
    setPending: hydrations.set,
    removePending: hydrations.remove,
    fetchSessionConfig: (_params, run) => run(),
  }
  const switcher: HarnessSwitcherCache = {
    getPending: switches.get,
    setPending: switches.set,
    removePending: switches.remove,
    clearOptionsTries: options.clearTries,
  }
  const sessionModel: HarnessSessionModelSyncCache = {
    getState: (key) => syncStates.get(key),
    setState: (key, value) => void syncStates.set(key, value),
    getPending: (key, model) => syncs.get(`${key}\n${model}`),
    setPending: (key, model, value) => syncs.set(`${key}\n${model}`, value),
    removePending: (key, model, value) => syncs.remove(`${key}\n${model}`, value),
  }
  return { options, hydrator, switcher, sessionModel }
}

export function createHarnessConfigStore(server: Server, storage: DraftDefaultStorage) {
  const api = server.harnessConfig
  const connectionCatalog = createHarnessConnectionsCatalog({ api })
  let connectionRefresh: Promise<void> | undefined
  const hasConfigOptions = async (type: HarnessType) => {
    if (type.kind === "native") return harnessHasConfigOptions(type)
    if (!connectionCatalog.data()) {
      connectionRefresh ??= connectionCatalog.refresh().finally(() => { connectionRefresh = undefined })
      await connectionRefresh
    }
    const catalog = connectionCatalog.data()
    if (catalog?.status === "unsupported") throw new Error(catalog.reason)
    const row = catalog?.connections.find((item) => item.connectionId === type.connectionId)
    if (!row) {
      throw new Error(connectionCatalog.error() ?? `Connection ${type.connectionId} is unavailable`)
    }
    return row.capabilities.configOptions
  }
  const harnessStore = createHarnessStore(storage)
  const caches = createScopeCaches()

  const optionsLoader = createHarnessOptionsLoader<ScopeInput>({
    fetch: (type, params, model) => {
      if (!params?.placementId) return Promise.resolve({ source: "empty", stale: false, offersOptions: false, serviceTiers: [] })
      return api.options({
        placementId: params.placementId,
        harness: harnessSelectionId(type),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(model ? { model } : {}),
      })
    },
    currentHarness: (scope) => harnessStore.state(scope)?.harness,
    selectedModel: (scope) => harnessStore.state(scope)?.selectedModel,
    selectedThoughtLevel: (scope) => harnessStore.state(scope)?.selectedThoughtLevel,
    modelOptional: harnessStore.canOmitModel,
    preserveSelectedModel: harnessStore.protectDraftModel,
    seed: harnessStore.seed,
    applyPatch: harnessStore.applyPatch,
    draftDefaultApplication: harnessStore.draftDefaultApplication,
    resolveDraftDefault: harnessStore.applyDraftDefault,
    setOptionsLoading: harnessStore.setOptionsLoading,
    readState: (scope) => {
      const state = harnessStore.state(scope)
      return state ? { readiness: state.readiness, configError: state.configError } : undefined
    },
    cache: caches.options,
  })

  // A held pick's options are the picked harness's, which only the
  // placement-scoped read answers: the session read serves the harness the
  // session still runs.
  async function fetchConfigOptions(
    scope: string,
    type: HarnessType,
    input?: ScopeInput,
  ): Promise<HarnessOptions | undefined> {
    return optionsLoader.load(scope, type, harnessStore.heldHarness(scope) && input ? { ...input, sessionId: undefined } : input)
  }

  const statusActions = createHarnessStatusActions<ScopeInput>({
    applyPatch: harnessStore.applyPatch,
    state: harnessStore.state,
    fetchConfigOptions,
    hasConfigOptions,
  })

  const hydrator = createHarnessHydrator<ScopeInput>({
    seed: harnessStore.seed,
    state: harnessStore.state,
    beginDraftDefault: (scope, input) => {
      const identity = draftDefaultIdentity(input)
      if (!identity) return undefined
      return harnessStore.beginDraftDefault(scope, identity)
    },
    markServer: harnessStore.markServer,
    applyStatus: statusActions.applyStatus,
    setPollingHydration: statusActions.setPollingHydration,
    setReadyHydration: statusActions.setReadyHydration,
    setCapabilityError: (scope, message) => {
      harnessStore.applyPatch(scope, { configError: message, readiness: "error", optionsLoading: false })
    },
    fetchConfigOptions,
    hasConfigOptions,
    runtime: {
      placementKind: (placementId) => server.placements.byId(placementId)?.kind,
      folderHarness: (placementId) => api.folderHarness(placementId),
      sessionConfig: api.sessionConfig,
    },
    cache: caches.hydrator,
  })

  const modelWriter = createHarnessModelWriter<ScopeInput>({
    seed: harnessStore.seed,
    acceptsDraftModel: harnessStore.acceptsDraftModel,
    currentModel: (scope) => {
      const state = harnessStore.state(scope)
      return state?.selectedModel && state.selectedModelProvider
        ? { providerId: state.selectedModelProvider, modelId: state.selectedModel }
        : undefined
    },
    setSelectedModel: harnessStore.setSelectedModel,
    holdsHarness: (scope) => !!harnessStore.heldHarness(scope),
    reloadOptions: async (scope, params) => {
      const harness = harnessStore.state(scope)?.harness
      if (!harness || isCatalogHarness(harness) || !await hasConfigOptions(harness)) return
      await fetchConfigOptions(scope, harness, params)
    },
    rememberDraftModel: (scope, model, input, labels) => {
      rememberDraftModel(scope, model, input, labels)
    },
    runtime: {
      setSessionModel: (ref, model) => api.updateSessionConfig(ref, { model: { providerId: model.providerId, modelId: model.modelId } }),
    },
    cache: caches.sessionModel,
  })

  const switcher = createHarnessSwitcher<ScopeInput>({
    seed: harnessStore.seed,
    applyPatch: harnessStore.applyPatch,
    holdHarness: harnessStore.holdHarness,
    restoreHeldHarness: harnessStore.restoreHeldHarness,
    beginDraftHarnessChoice: (scope, type, input) => {
      const identity = draftDefaultIdentity(input)
      if (identity) harnessStore.beginDraftHarnessChoice(scope, identity, type)
    },
    rememberDraftHarness: (scope, type, input) => {
      rememberDraftHarness(scope, type, input)
    },
    fetchConfigOptions: (scope, type, input) => {
      void fetchConfigOptions(scope, type, input)
    },
    hasConfigOptions,
    cache: caches.switcher,
  })

  const setHarness: typeof switcher.setHarness = (scope, type, input) => {
    hydrator.cancel(scope)
    return switcher.setHarness(scope, type, input)
  }

  function draftDefaultIdentity(input?: ScopeInput) {
    if (!input?.placementId || (input.sessionId && input.sessionId !== "new")) return undefined
    const workspaceKey = api.workspaceKey(input.placementId)
    if (!workspaceKey) return undefined
    return { serverUrl: api.serverUrl, workspaceKey }
  }

  const rememberDraftHarness = (scope: string, type: HarnessType, input?: ScopeInput) => {
    const identity = draftDefaultIdentity(input)
    if (!identity) return false
    return harnessStore.rememberDraftHarness(scope, identity, type, input?.saveDraftDefault !== false)
  }

  const rememberDraftModel = (scope: string, model: ModelChoice, input?: ScopeInput, labels?: DraftDefaultLabels) => {
    const identity = draftDefaultIdentity(input)
    if (!identity) return false
    return harnessStore.rememberDraftModel(scope, identity, model, labels, input?.saveDraftDefault !== false)
  }

  const resolveCurrentDraftDefault = (
    scope: string,
    input: Omit<ResolveDraftDefaultInput, "saved">,
  ) => {
    const type = harnessStore.state(scope)?.draftDefault?.harness
    if (!type) return false
    const application = harnessStore.draftDefaultApplication(scope, type)
    if (!application) return false
    return harnessStore.applyDraftDefault(application, input)
  }

  // Probe the bound runtime without changing persisted harness/model identity.
  // Hydration alone cannot detect a runtime that exits after the session loads.
  const probeHarnessHealth = async (scope: string, input?: ScopeInput) => {
    if (!input?.placementId || harnessStore.heldHarness(scope)) return
    const current = harnessStore.read(scope)
    if (!current.harness) return
    const data = await api.folderHarness(input.placementId, input.sessionId).catch((error: unknown) => {
      console.warn(`The harness health probe for placement ${input.placementId} failed`, error)
      return undefined
    })
    if (!data) return
    const held = harnessStore.read(scope)
    if (held.harness?.kind !== current.harness.kind || (held.harness.kind === "connection" && (current.harness.kind !== "connection" || held.harness.connectionId !== current.harness.connectionId))) return
    if (held.harness.kind === "connection" && data.connectionState?.connectionId === held.harness.connectionId) {
      harnessStore.applyPatch(scope, { connectionState: data.connectionState })
    }
    const next = harnessHealthReadiness({
      harness: current.harness,
      current: harnessStore.read(scope).readiness,
      health: data.harnessHealth?.status,
    })
    if (next) harnessStore.setReadiness(scope, next)
  }

  /** A harness held in the picker becomes the session's own before the prompt is sent; a failed switch leaves the draft unsent. */
  const commitHeldHarness = async (scope: string, input: ScopeInput) => {
    const held = harnessStore.heldHarness(scope)
    const ref = input.sessionRef
    if (!held || !ref) return
    const model = harnessStore.harnessModelKeyForSubmit(scope)
    await api.updateSessionConfig(ref, {
      harness: harnessSelectionId(held),
      ...(model ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
    })
    harnessStore.releaseHeldHarness(scope)
  }

  return {
    hydrate: hydrator.hydrate,
    commitHeldHarness,
    reprobe: hydrator.reprobe,
    probeHealth: probeHarnessHealth,
    // Give up on a harness that never left "polling": surface the terminal
    // "error" readiness so the selector shows the "Unavailable" affordance and
    // submit stays blocked (harnessReadyForSubmit is false for "error").
    markUnavailable: (scope: string) => harnessStore.setReadiness(scope, "error"),
    promote: harnessStore.promote,
    rememberDraftModel,
    resolveDraftDefault: resolveCurrentDraftDefault,
    setModel: modelWriter.setModel,
    setHarness,
    heldHarness: harnessStore.heldHarness,
    releaseHeldHarness: harnessStore.releaseHeldHarness,
    canOmitModel: harnessStore.canOmitModel,
    canCreateWithoutModel: harnessStore.canCreateWithoutModel,
    setConnectionDeclaration: harnessStore.setConnectionDeclaration,
    harnessMode: harnessStore.harnessMode,
    selectedModel: harnessStore.selectedModel,
    selectedModelKey: harnessStore.selectedModelKey,
    harness: harnessStore.harness,
    models: harnessStore.models,
    thoughtLevels: harnessStore.thoughtLevels,
    setThoughtLevel: harnessStore.setThoughtLevel,
    selectedThoughtLevel: harnessStore.selectedThoughtLevel,
    serviceTiers: harnessStore.serviceTiers,
    setServiceTier: harnessStore.setServiceTier,
    selectedServiceTier: harnessStore.selectedServiceTier,
    displayName: harnessStore.displayName,
    isHarnessMode: harnessStore.isHarnessMode,
    readiness: (scope: string) => harnessStore.read(scope).readiness,
    connectionState: (scope: string) => harnessStore.read(scope).connectionState,
    optionsSource: harnessStore.optionsSource,
    optionsStale: harnessStore.optionsStale,
    optionsLoading: harnessStore.optionsLoading,
    configError: harnessStore.configError,
    draftDefaultState: harnessStore.draftDefaultState,
    draftDefaultLabels: harnessStore.draftDefaultLabels,
    draftDefaultModel: harnessStore.draftDefaultModel,
    draftDefaultAuthority: harnessStore.draftDefaultAuthority,
    harnessModelKeyForSubmit: harnessStore.harnessModelKeyForSubmit,
    settledModel: modelWriter.settledModel,
    harnessServiceTierForSubmit: harnessStore.harnessServiceTierForSubmit,
    harnessModelNameForSubmit: harnessStore.harnessModelNameForSubmit,
    harnessReadyForSubmit: harnessStore.harnessReadyForSubmit,
  }
}

export type HarnessConfigStore = ReturnType<typeof createHarnessConfigStore>
