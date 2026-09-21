import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { HarnessModelChoice, HarnessReadiness } from "./selection"
import type { HarnessConnectionState, HarnessModelOption, HarnessType } from "./profile"
import type { DraftDefaultLabels } from "./draft-defaults"
import type { DraftDefaultResult, DraftDefaultAuthority, ResolveDraftDefaultInput } from "./draft-default-policy"
import type { PreparedRuntimeSessionConfig } from "./prepared-session"

export type HarnessScopeInput = {
  directory?: string
  sessionId?: string
  sessionRef?: SessionRef
}

export type HarnessSessionClaimInput = HarnessScopeInput & {
  headers?: Record<string, string>
  harness: HarnessType
  sessionConfig: PreparedRuntimeSessionConfig
}

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
  setModel(scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | Promise<void>
  setThoughtLevel(scope: string, value: string | undefined): void
  rememberDraftModel(scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels): void | boolean
  resolveDraftDefault(scope: string, input: Omit<ResolveDraftDefaultInput, "saved">): boolean
  harness(scope: string): HarnessType | undefined
  isHarnessMode(scope: string): boolean
  readiness(scope: string): HarnessReadiness
  connectionState?(scope: string): HarnessConnectionState | undefined
  models(scope: string): HarnessModelChoice[]
  thoughtLevels(scope: string): HarnessModelOption[]
  setThoughtLevel(scope: string, value: string | undefined): void
  selectedThoughtLevel(scope: string): string | undefined
  selectedModel(scope: string): string
  selectedModelKey(scope: string): ModelKey | undefined
  optionsStale(scope: string): boolean
  optionsLoading(scope: string): boolean
  configError(scope: string): string | undefined
  draftDefaultState(scope: string): DraftDefaultResult["state"] | undefined
  draftDefaultLabels(scope: string): DraftDefaultLabels | undefined
  draftDefaultModel(scope: string): ModelKey | undefined
  draftDefaultAuthority?(scope: string): DraftDefaultAuthority | undefined
}

export type HarnessSubmitControllerStore = HarnessSelectionControllerStore & {
  claimSession(scope: string, input: HarnessSessionClaimInput): Promise<{ id: string } | undefined>
  promote(from: string, to: string): void
  harnessReadyForSubmit(scope: string): boolean
  harnessModelKeyForSubmit(scope: string): ModelKey | undefined
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
  thoughtLevels: HarnessModelOption[]
  selectedThoughtLevel: string | undefined
  selectedModelKey?: ModelKey
  optionsStale: boolean
  optionsLoading: boolean
  configError: string | undefined
  draftDefaultState?: DraftDefaultResult["state"]
  draftDefaultLabels?: DraftDefaultLabels
  draftDefaultModel?: ModelKey
  draftDefaultAuthority?: DraftDefaultAuthority
}

export function createHarnessSelectionController(store: HarnessSelectionControllerStore) {
  return {
    read(scope: string): HarnessSelectionSnapshot {
      const selectedModelKey = store.selectedModelKey(scope)
      return {
        harness: store.harness(scope),
        canCreateWithoutModel: store.canCreateWithoutModel?.(scope),
        isHarnessMode: store.isHarnessMode(scope),
        readiness: store.readiness(scope),
        connectionState: store.connectionState?.(scope),
        models: store.models(scope),
        selectedModel: store.selectedModel(scope),
        selectedModelProvider: selectedModelKey?.providerID,
        thoughtLevels: store.thoughtLevels(scope),
        selectedThoughtLevel: store.selectedThoughtLevel(scope),
        selectedModelKey,
        optionsStale: store.optionsStale(scope),
        optionsLoading: store.optionsLoading(scope),
        configError: store.configError(scope),
        draftDefaultState: store.draftDefaultState(scope),
        draftDefaultLabels: store.draftDefaultLabels(scope),
        draftDefaultModel: store.draftDefaultModel(scope),
        draftDefaultAuthority: store.draftDefaultAuthority?.(scope),
      }
    },
    setConnectionDeclaration: (scope: string, declaration: HarnessConnectionRef | undefined) => store.setConnectionDeclaration?.(scope, declaration),
    hydrate: (scope: string, input?: HarnessScopeInput) => store.hydrate(scope, input),
    reprobe: (scope: string, input?: HarnessScopeInput) => store.reprobe(scope, input),
    probeHealth: (scope: string, input?: HarnessScopeInput) => store.probeHealth(scope, input),
    markUnavailable: (scope: string) => store.markUnavailable(scope),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput) =>
      store.setHarness(scope, type, input),
    setModel: (scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels) =>
      store.setModel(scope, model, input, labels),
    setThoughtLevel: (scope: string, value: string | undefined) => store.setThoughtLevel(scope, value),
    rememberDraftModel: (scope: string, model: ModelKey, input?: HarnessScopeInput, labels?: DraftDefaultLabels) =>
      store.rememberDraftModel(scope, model, input, labels),
    resolveDraftDefault: (scope: string, input: Omit<ResolveDraftDefaultInput, "saved">) =>
      store.resolveDraftDefault(scope, input),
  }
}

export type HarnessSelectionController = ReturnType<typeof createHarnessSelectionController>

export function createHarnessSubmitController(store: HarnessSubmitControllerStore | undefined) {
  return {
    harness: (scope: string): HarnessType | undefined => store?.harness(scope),
    isHarnessMode: (scope: string) => store?.isHarnessMode(scope) ?? false,
    readiness: (scope: string): HarnessReadiness => store?.readiness(scope) ?? "unresolved",
    canOmitModel: (scope: string) => store?.canOmitModel?.(scope) ?? false,
    canCreateWithoutModel: (scope: string) => store?.canCreateWithoutModel?.(scope) ?? false,
    readyForSubmit: (scope: string) => store?.harnessReadyForSubmit(scope) ?? false,
    modelKeyForSubmit: (scope: string) => store?.harnessModelKeyForSubmit(scope),
    claimSession: (scope: string, input: HarnessSessionClaimInput) =>
      store?.claimSession(scope, input) ?? Promise.resolve(undefined),
    setHarness: (scope: string, type: HarnessType, input?: HarnessScopeInput) =>
      store?.setHarness(scope, type, input) ?? Promise.resolve(),
    promote: (from: string, to: string) => store?.promote(from, to),
  }
}

export type HarnessSubmitController = ReturnType<typeof createHarnessSubmitController>
