import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { HarnessModelChoice, HarnessReadiness } from "./selection"
import type { HarnessType } from "./profile"
import type { DraftDefaultLabels } from "./draft-defaults"
import type { DraftDefaultResult, ResolveDraftDefaultInput } from "./draft-default-policy"

export type HarnessScopeInput = {
  directory?: string
  sessionId?: string
}

export type HarnessSelectionControllerStore = {
  hydrate(scope: string, input?: HarnessScopeInput): void | Promise<void>
  /** Re-run a hydration probe for a scope still stuck in "polling". */
  reprobe(scope: string, input?: HarnessScopeInput): void | Promise<void>
  /**
   * Standing harness-health probe (T4): fetch the harness route directly and move
   * readiness ready<->degraded from the forwarded `harnessHealth`. Unlike
   * `reprobe`, it bypasses the session-config short-circuit so a harness that died
   * after settling is observed on an existing session.
   */
  probeHealth(scope: string, input?: HarnessScopeInput): void | Promise<void>
  /** Transition a never-settling harness to the terminal "error" readiness. */
  markUnavailable(scope: string): void
  setHarness(scope: string, type: HarnessType, input?: HarnessScopeInput, binary?: string): void | Promise<void>
  setModel(scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | Promise<void>
  rememberDraftModel(scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | boolean
  resolveDraftDefault(scope: string, input: Omit<ResolveDraftDefaultInput, "saved">): boolean
  harness(scope: string): HarnessType
  isHarnessMode(scope: string): boolean
  readiness(scope: string): HarnessReadiness
  models(scope: string): HarnessModelChoice[]
  selectedModel(scope: string): string
  selectedModelKey(scope: string): ModelKey | undefined
  optionsStale(scope: string): boolean
  optionsLoading(scope: string): boolean
  configError(scope: string): string | undefined
  draftDefaultState(scope: string): DraftDefaultResult["state"] | undefined
  draftDefaultLabels(scope: string): DraftDefaultLabels | undefined
  draftDefaultModel(scope: string): ModelKey | undefined
}

export type HarnessSubmitControllerStore = HarnessSelectionControllerStore & {
  claimSession(scope: string, input?: HarnessScopeInput): Promise<{ id: string } | undefined>
  promote(from: string, to: string): void
  harnessReadyForSubmit(scope: string): boolean
  harnessModelKeyForSubmit(scope: string): ModelKey | undefined
}

export type HarnessSelectionSnapshot = {
  harness: HarnessType
  isHarnessMode: boolean
  readiness: HarnessReadiness
  models: HarnessModelChoice[]
  selectedModel: string
  selectedModelKey?: ModelKey
  optionsStale: boolean
  optionsLoading: boolean
  configError: string | undefined
  draftDefaultState?: DraftDefaultResult["state"]
  draftDefaultLabels?: DraftDefaultLabels
  draftDefaultModel?: ModelKey
}

export function createHarnessSelectionController(store: HarnessSelectionControllerStore) {
  return {
    read(scope: string): HarnessSelectionSnapshot {
      return {
        harness: store.harness(scope),
        isHarnessMode: store.isHarnessMode(scope),
        readiness: store.readiness(scope),
        models: store.models(scope),
        selectedModel: store.selectedModel(scope),
        selectedModelKey: store.selectedModelKey(scope),
        optionsStale: store.optionsStale(scope),
        optionsLoading: store.optionsLoading(scope),
        configError: store.configError(scope),
        draftDefaultState: store.draftDefaultState(scope),
        draftDefaultLabels: store.draftDefaultLabels(scope),
        draftDefaultModel: store.draftDefaultModel(scope),
      }
    },
    hydrate: (scope: string, input?: HarnessScopeInput) => store.hydrate(scope, input),
    reprobe: (scope: string, input?: HarnessScopeInput) => store.reprobe(scope, input),
    probeHealth: (scope: string, input?: HarnessScopeInput) => store.probeHealth(scope, input),
    markUnavailable: (scope: string) => store.markUnavailable(scope),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput, binary?: string) =>
      store.setHarness(scope, type, input, binary),
    setModel: (scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels) =>
      store.setModel(scope, model, input, labels),
    rememberDraftModel: (scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels) =>
      store.rememberDraftModel(scope, model, input, labels),
    resolveDraftDefault: (scope: string, input: Omit<ResolveDraftDefaultInput, "saved">) =>
      store.resolveDraftDefault(scope, input),
  }
}

export type HarnessSelectionController = ReturnType<typeof createHarnessSelectionController>

export function createHarnessSubmitController(store: HarnessSubmitControllerStore | undefined) {
  return {
    harness: (scope: string): HarnessType => store?.harness(scope) ?? "opencode",
    isHarnessMode: (scope: string) => store?.isHarnessMode(scope) ?? false,
    readiness: (scope: string): HarnessReadiness => store?.readiness(scope) ?? "ready",
    readyForSubmit: (scope: string) => store?.harnessReadyForSubmit(scope) ?? true,
    modelKeyForSubmit: (scope: string) => store?.harnessModelKeyForSubmit(scope),
    claimSession: (scope: string, input?: HarnessScopeInput) =>
      store?.claimSession(scope, input) ?? Promise.resolve(undefined),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput, binary?: string) =>
      store?.setHarness(scope, type, input, binary) ?? Promise.resolve(),
    promote: (from: string, to: string) => store?.promote(from, to),
  }
}

export type HarnessSubmitController = ReturnType<typeof createHarnessSubmitController>
