// target-layer: session
import type { ModelKey } from "@/session/composer/model-strategy"
import type { HarnessReadiness } from "./selection"
import type { HarnessType } from "./profile"

export type HarnessScopeInput = {
  directory?: string
  sessionId?: string
}

export type HarnessSelectionControllerStore = {
  hydrate(scope: string, input?: HarnessScopeInput): void | Promise<void>
  setHarness(scope: string, type: HarnessType, input?: HarnessScopeInput, binary?: string): void | Promise<void>
  setModel(scope: string, model: string, input?: HarnessScopeInput): void | Promise<void>
  harness(scope: string): HarnessType
  isHarnessMode(scope: string): boolean
  readiness(scope: string): HarnessReadiness
  models(scope: string): { id: string; name: string }[]
  selectedModel(scope: string): string
  optionsStale(scope: string): boolean
  optionsLoading(scope: string): boolean
  configError(scope: string): string | undefined
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
  models: { id: string; name: string }[]
  selectedModel: string
  optionsStale: boolean
  optionsLoading: boolean
  configError: string | undefined
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
        optionsStale: store.optionsStale(scope),
        optionsLoading: store.optionsLoading(scope),
        configError: store.configError(scope),
      }
    },
    hydrate: (scope: string, input?: HarnessScopeInput) => store.hydrate(scope, input),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput, binary?: string) =>
      store.setHarness(scope, type, input, binary),
    setModel: (scope: string, model: string, input?: HarnessScopeInput) => store.setModel(scope, model, input),
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
