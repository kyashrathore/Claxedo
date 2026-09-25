import type { HarnessConnectionState, HarnessOptionChoice, ModelChoice } from "@/server"
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
  /** Re-run a hydration probe for a scope still stuck in "polling". */
  reprobe(scope: string, input?: HarnessScopeInput): void | Promise<void>
  /**
   * Standing harness-health probe: fetch the harness route directly and move
   * readiness ready<->degraded from the forwarded `harnessHealth`. Unlike
   * `reprobe`, it bypasses the session-config short-circuit so a harness that died
   * after settling is observed on an existing session.
   */
  probeHealth(scope: string, input?: HarnessScopeInput): void | Promise<void>
  /** Transition a never-settling harness to the terminal "error" readiness. */
  markUnavailable(scope: string): void
  setHarness(scope: string, type: HarnessType, input?: HarnessScopeInput): void | Promise<void>
  setModel(scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | Promise<void>
  setThoughtLevel(scope: string, value: string | undefined): void
  setServiceTier(scope: string, value: string | undefined): void
  rememberDraftModel(scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | boolean
  resolveDraftDefault(scope: string, input: Omit<ResolveDraftDefaultInput, "saved">): boolean
  harness(scope: string): HarnessType | undefined
  /** The harness picked for an existing session that its next send switches it to. */
  heldHarness?(scope: string): HarnessType | undefined
  isHarnessMode(scope: string): boolean
  readiness(scope: string): HarnessReadiness
  connectionState?(scope: string): HarnessConnectionState | undefined
  models(scope: string): HarnessModelChoice[]
  thoughtLevels(scope: string): readonly HarnessOptionChoice[]
  setThoughtLevel(scope: string, value: string | undefined): void
  selectedThoughtLevel(scope: string): string | undefined
  serviceTiers(scope: string): readonly HarnessOptionChoice[]
  setServiceTier(scope: string, value: string | undefined): void
  selectedServiceTier(scope: string): string | undefined
  selectedModel(scope: string): string
  selectedModelKey(scope: string): ModelChoice | undefined
  optionsStale(scope: string): boolean
  optionsLoading(scope: string): boolean
  configError(scope: string): string | undefined
  draftDefaultState(scope: string): DraftDefaultResult["state"] | undefined
  draftDefaultLabels(scope: string): DraftDefaultLabels | undefined
  draftDefaultModel(scope: string): ModelChoice | undefined
  draftDefaultAuthority?(scope: string): DraftDefaultAuthority | undefined
}

export type HarnessSubmitControllerStore = HarnessSelectionControllerStore & {
  promote(from: string, to: string): void
  harnessReadyForSubmit(scope: string): boolean
  harnessModelKeyForSubmit(scope: string): ModelChoice | undefined
  settledModel?(scope: string): Promise<void>
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
  /** Reasoning/thinking levels for the CURRENT model, when offered. */
  thoughtLevels: readonly HarnessOptionChoice[]
  selectedThoughtLevel: string | undefined
  /** Faster tiers the CURRENT model offers; empty when it runs at one speed. */
  serviceTiers: readonly HarnessOptionChoice[]
  selectedServiceTier: string | undefined
  selectedModelKey?: ModelChoice
  optionsStale: boolean
  optionsLoading: boolean
  configError: string | undefined
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
    configError: store.configError(scope),
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
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput) =>
      store.setHarness(scope, type, input),
    setModel: (scope: string, model: ModelChoice, input?: HarnessScopeInput, labels?: DraftDefaultLabels) =>
      store.setModel(scope, model, input, labels),
    setThoughtLevel: (scope: string, value: string | undefined) => store.setThoughtLevel(scope, value),
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
    settledModel: (scope: string) => store?.settledModel?.(scope) ?? Promise.resolve(),
    serviceTierForSubmit: (scope: string) => store?.harnessServiceTierForSubmit(scope),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput) =>
      store?.setHarness(scope, type, input) ?? Promise.resolve(),
    promote: (from: string, to: string) => store?.promote(from, to),
  }
}

