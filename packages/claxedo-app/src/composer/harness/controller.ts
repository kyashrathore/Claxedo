import type { HarnessConnectionState, HarnessOptionChoice, HarnessUnavailableHere, ModelChoice } from "@/server"
import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import type { HarnessModelChoice, HarnessReadiness } from "./selection"
import type { HarnessType } from "./profile"
import type { DraftDefaultLabels } from "./draft-defaults"
import type { DraftDefaultResult, DraftDefaultAuthority, ResolveDraftDefaultInput } from "./draft-default-policy"
import type { HarnessScopeInput } from "./store-policy"

export type { HarnessScopeInput } from "./store-policy"

export type HarnessSelectionControllerStore = {
  canOmitModel?(scope: string): boolean
  canCreateWithoutModel?(scope: string): boolean
  setConnectionDeclaration?(scope: string, declaration: HarnessConnectionRef | undefined): void
  hydrate(scope: string, input?: HarnessScopeInput): void | Promise<void>
  reprobe(scope: string, input?: HarnessScopeInput): void | Promise<void>
  probeHealth(scope: string, input?: HarnessScopeInput): void | Promise<void>
  markUnavailable(scope: string): void
  setHarness(scope: string, type: HarnessType, input?: HarnessScopeInput, model?: ModelChoice): void | Promise<void>
  setModel(scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | Promise<void>
  setThoughtLevel(scope: string, value: string | undefined, input?: HarnessScopeInput): void | Promise<void>
  setServiceTier(scope: string, value: string | undefined): void
  rememberDraftModel(scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | boolean
  resolveDraftDefault(scope: string, input: Omit<ResolveDraftDefaultInput, "saved">): boolean
  harness(scope: string): HarnessType | undefined
  heldHarness?(scope: string): HarnessType | undefined
  isHarnessMode(scope: string): boolean
  readiness(scope: string): HarnessReadiness
  connectionState?(scope: string): HarnessConnectionState | undefined
  models(scope: string): HarnessModelChoice[]
  thoughtLevels(scope: string): readonly HarnessOptionChoice[]
  selectedThoughtLevel(scope: string): string | undefined
  serviceTiers(scope: string): readonly HarnessOptionChoice[]
  selectedServiceTier(scope: string): string | undefined
  selectedModel(scope: string): string
  selectedModelKey(scope: string): ModelChoice | undefined
  optionsStale(scope: string): boolean
  optionsLoading(scope: string): boolean
  optionsAnswered(scope: string): boolean
  configError(scope: string): string | undefined
  unavailableHere(scope: string): HarnessUnavailableHere | undefined
  draftDefaultState(scope: string): DraftDefaultResult["state"] | undefined
  draftDefaultLabels(scope: string): DraftDefaultLabels | undefined
  draftDefaultModel(scope: string): ModelChoice | undefined
  draftDefaultAuthority?(scope: string): DraftDefaultAuthority | undefined
}

export type HarnessSubmitControllerStore = HarnessSelectionControllerStore & {
  promote(from: string, to: string): void
  harnessReadyForSubmit(scope: string): boolean
  harnessModelKeyForSubmit(scope: string): ModelChoice | undefined
  settledConfig?(scope: string): Promise<void>
  harnessServiceTierForSubmit(scope: string): string | undefined
  releaseHeldHarness?(scope: string): void
}

export type HarnessSelectionSnapshot = {
  canCreateWithoutModel?: boolean
  harness?: HarnessType
  isHarnessMode: boolean
  readiness: HarnessReadiness
  connectionState?: HarnessConnectionState
  models: HarnessModelChoice[]
  selectedModel: string
  selectedModelProvider?: string
  thoughtLevels: readonly HarnessOptionChoice[]
  selectedThoughtLevel: string | undefined
  serviceTiers: readonly HarnessOptionChoice[]
  selectedServiceTier: string | undefined
  selectedModelKey?: ModelChoice
  optionsStale: boolean
  optionsLoading: boolean
  optionsAnswered: boolean
  configError: string | undefined
  unavailableHere?: HarnessUnavailableHere
  draftDefaultState?: DraftDefaultResult["state"]
  draftDefaultLabels?: DraftDefaultLabels
  draftDefaultModel?: ModelChoice
  draftDefaultAuthority?: DraftDefaultAuthority
}

function readSelection(store: HarnessSelectionControllerStore, scope: string): HarnessSelectionSnapshot {
  const selectedModelKey = store.selectedModelKey(scope)
  return {
    harness: store.harness(scope),
    canCreateWithoutModel: store.canCreateWithoutModel?.(scope),
    isHarnessMode: store.isHarnessMode(scope),
    readiness: store.readiness(scope),
    connectionState: store.connectionState?.(scope),
    models: store.models(scope),
    selectedModel: store.selectedModel(scope),
    selectedModelProvider: selectedModelKey?.providerId,
    thoughtLevels: store.thoughtLevels(scope),
    selectedThoughtLevel: store.selectedThoughtLevel(scope),
    serviceTiers: store.serviceTiers(scope),
    selectedServiceTier: store.selectedServiceTier(scope),
    selectedModelKey,
    optionsStale: store.optionsStale(scope),
    optionsLoading: store.optionsLoading(scope),
    optionsAnswered: store.optionsAnswered(scope),
    configError: store.configError(scope),
    unavailableHere: store.unavailableHere(scope),
    draftDefaultState: store.draftDefaultState(scope),
    draftDefaultLabels: store.draftDefaultLabels(scope),
    draftDefaultModel: store.draftDefaultModel(scope),
    draftDefaultAuthority: store.draftDefaultAuthority?.(scope),
  }
}

export function createHarnessSelectionController(store: HarnessSelectionControllerStore) {
  return {
    read: (scope: string) => readSelection(store, scope),
    setConnectionDeclaration: (scope: string, declaration: HarnessConnectionRef | undefined) => store.setConnectionDeclaration?.(scope, declaration),
    hydrate: (scope: string, input?: HarnessScopeInput) => store.hydrate(scope, input),
    reprobe: (scope: string, input?: HarnessScopeInput) => store.reprobe(scope, input),
    probeHealth: (scope: string, input?: HarnessScopeInput) => store.probeHealth(scope, input),
    markUnavailable: (scope: string) => store.markUnavailable(scope),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput, model?: ModelChoice) =>
      store.setHarness(scope, type, input, model),
    setModel: (scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels) =>
      store.setModel(scope, model, input, labels),
    setThoughtLevel: (scope: string, value: string | undefined, input?: HarnessScopeInput) => store.setThoughtLevel(scope, value, input),
    setServiceTier: (scope: string, value: string | undefined) => store.setServiceTier(scope, value),
    rememberDraftModel: (scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels) =>
      store.rememberDraftModel(scope, model, input, labels),
    resolveDraftDefault: (scope: string, input: Omit<ResolveDraftDefaultInput, "saved">) =>
      store.resolveDraftDefault(scope, input),
  }
}

export type HarnessSelectionController = ReturnType<typeof createHarnessSelectionController>

export function createHarnessSubmitController(store: HarnessSubmitControllerStore | undefined) {
  return {
    harness: (scope: string): HarnessType | undefined => store?.harness(scope),
    heldHarness: (scope: string): HarnessType | undefined => store?.heldHarness?.(scope),
    releaseHeldHarness: (scope: string) => store?.releaseHeldHarness?.(scope),
    isHarnessMode: (scope: string) => store?.isHarnessMode(scope) ?? false,
    readiness: (scope: string): HarnessReadiness => store?.readiness(scope) ?? "unresolved",
    canOmitModel: (scope: string) => store?.canOmitModel?.(scope) ?? false,
    canCreateWithoutModel: (scope: string) => store?.canCreateWithoutModel?.(scope) ?? false,
    readyForSubmit: (scope: string) => store?.harnessReadyForSubmit(scope) ?? false,
    modelKeyForSubmit: (scope: string) => store?.harnessModelKeyForSubmit(scope),
    settledConfig: (scope: string) => store?.settledConfig?.(scope) ?? Promise.resolve(),
    serviceTierForSubmit: (scope: string) => store?.harnessServiceTierForSubmit(scope),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput) =>
      store?.setHarness(scope, type, input) ?? Promise.resolve(),
    promote: (from: string, to: string) => store?.promote(from, to),
  }
}

