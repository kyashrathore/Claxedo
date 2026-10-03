import type { HarnessConfigApi, HarnessOptions, ModelChoice, Server } from "@/server"
import type { ResolveDraftDefaultInput } from "./draft-default-policy"
import type { DraftDefaultLabels } from "./draft-defaults"
import { createHarnessHydrator } from "./harness-hydrator"
import { createHarnessModelWriter } from "./harness-model-writer"
import { createHarnessOptionsLoader } from "./harness-options-loader"
import { createHarnessStatusActions } from "./harness-status-actions"
import type { createHarnessStore } from "./harness-store"
import { createHarnessSwitcher } from "./harness-switcher"
import { harnessSelectionId, isCatalogHarness, type HarnessType } from "./profile"
import type { ScopeCaches } from "./scope-caches"
import type { HarnessScopeInput } from "./store-policy"

export type HarnessWiring = {
  readonly server: Server
  readonly api: HarnessConfigApi
  readonly store: ReturnType<typeof createHarnessStore>
  readonly caches: ScopeCaches
  readonly hasConfigOptions: (type: HarnessType) => Promise<boolean>
}

export type FetchConfigOptions = (scope: string, type: HarnessType, input?: HarnessScopeInput) => Promise<HarnessOptions | undefined>

export function wireOptionsLoader({ api, store, caches }: HarnessWiring) {
  return createHarnessOptionsLoader<HarnessScopeInput>({
    fetch: (type, params, model) => {
      if (!params?.placementId) return Promise.resolve({ source: "empty", stale: false, offersOptions: false, serviceTiers: [] })
      return api.options({
        placementId: params.placementId,
        harness: harnessSelectionId(type),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(model ? { model } : {}),
      })
    },
    currentHarness: (scope) => store.state(scope)?.harness,
    selectedModel: (scope) => store.state(scope)?.selectedModel,
    selectedThoughtLevel: (scope) => store.state(scope)?.selectedThoughtLevel,
    modelOptional: store.canOmitModel,
    preserveSelectedModel: store.protectDraftModel,
    sessionModel: store.holdsSessionModel,
    seed: store.seed,
    applyPatch: store.applyPatch,
    draftDefaultApplication: store.draftDefaultApplication,
    resolveDraftDefault: store.applyDraftDefault,
    setOptionsLoading: store.setOptionsLoading,
    readState: (scope) => {
      const state = store.state(scope)
      return state ? { readiness: state.readiness, configError: state.configError } : undefined
    },
    cache: caches.options,
  })
}

export function wireHydrator(wiring: HarnessWiring, fetchConfigOptions: FetchConfigOptions) {
  const { server, api, store, hasConfigOptions } = wiring
  const statusActions = createHarnessStatusActions<HarnessScopeInput>({ applyPatch: store.applyPatch, state: store.state, fetchConfigOptions, hasConfigOptions })
  return createHarnessHydrator<HarnessScopeInput>({
    seed: store.seed,
    state: store.state,
    beginDraftDefault: (scope, input) => {
      const identity = draftDefaultIdentity(api, input)
      return identity ? store.beginDraftDefault(scope, identity) : undefined
    },
    markServer: store.markServer,
    applyStatus: statusActions.applyStatus,
    setPollingHydration: statusActions.setPollingHydration,
    setReadyHydration: statusActions.setReadyHydration,
    setCapabilityError: (scope, message) => store.applyPatch(scope, { configError: message, readiness: "error", optionsLoading: false }),
    fetchConfigOptions,
    hasConfigOptions,
    runtime: {
      placementKind: (placementId) => server.placements.byId(placementId)?.kind,
      folderHarness: (placementId) => api.folderHarness(placementId),
    },
    cache: wiring.caches.hydrator,
  })
}

export function wireModelWriter(wiring: HarnessWiring, fetchConfigOptions: FetchConfigOptions) {
  const { api, store, hasConfigOptions } = wiring
  return createHarnessModelWriter<HarnessScopeInput>({
    seed: store.seed,
    acceptsDraftModel: store.acceptsDraftModel,
    currentModel: (scope) => {
      const state = store.state(scope)
      return state?.selectedModel && state.selectedModelProvider ? { providerId: state.selectedModelProvider, modelId: state.selectedModel } : undefined
    },
    setSelectedModel: store.setSelectedModel,
    holdsHarness: (scope) => !!store.heldHarness(scope),
    reloadOptions: async (scope, params) => {
      const harness = store.state(scope)?.harness
      if (!harness || isCatalogHarness(harness) || !await hasConfigOptions(harness)) return
      await fetchConfigOptions(scope, harness, params)
    },
    rememberDraftModel: (scope, model, input, labels) => void rememberDraftModelInWorkspace(wiring, scope, model, input, labels),
    selectedEffort: (scope) => store.state(scope)?.selectedThoughtLevel,
    setSelectedEffort: store.setThoughtLevel,
    runtime: {
      setSessionModel: (ref, model) => api.updateSessionConfig(ref, { model: { providerId: model.providerId, modelId: model.modelId } }),
      setSessionEffort: (ref, effort) => api.updateSessionConfig(ref, { variant: effort ?? null }),
    },
  })
}

export function wireSwitcher(wiring: HarnessWiring, fetchConfigOptions: FetchConfigOptions) {
  const { api, store } = wiring
  return createHarnessSwitcher<HarnessScopeInput>({
    seed: store.seed,
    applyPatch: store.applyPatch,
    holdHarness: store.holdHarness,
    restoreHeldHarness: store.restoreHeldHarness,
    beginDraftHarnessChoice: (scope, type, input) => {
      const identity = draftDefaultIdentity(api, input)
      if (identity) store.beginDraftHarnessChoice(scope, identity, type)
    },
    rememberDraftHarness: (scope, type, input) => void rememberDraftHarnessInWorkspace(wiring, scope, type, input),
    fetchConfigOptions: (scope, type, input) => void fetchConfigOptions(scope, type, input),
    hasConfigOptions: wiring.hasConfigOptions,
    cache: wiring.caches.switcher,
  })
}

function draftDefaultIdentity(api: HarnessConfigApi, input?: HarnessScopeInput) {
  if (!input?.placementId || (input.sessionId && input.sessionId !== "new")) return undefined
  return { serverUrl: api.serverUrl, placementId: input.placementId }
}

function rememberDraftHarnessInWorkspace({ api, store }: HarnessWiring, scope: string, type: HarnessType, input?: HarnessScopeInput) {
  const identity = draftDefaultIdentity(api, input)
  return identity ? store.rememberDraftHarness(scope, identity, type, input?.saveDraftDefault !== false) : false
}

export function rememberDraftModelInWorkspace({ api, store }: HarnessWiring, scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels) {
  const identity = draftDefaultIdentity(api, input)
  return identity ? store.rememberDraftModel(scope, identity, model, labels, input?.saveDraftDefault !== false) : false
}

export function resolveCurrentDraftDefault({ store }: HarnessWiring, scope: string, input: Omit<ResolveDraftDefaultInput, "saved">) {
  const type = store.state(scope)?.draftDefault?.harness
  const application = type ? store.draftDefaultApplication(scope, type) : undefined
  return application ? store.applyDraftDefault(application, input) : false
}
