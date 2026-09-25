import type { HarnessOptionChoice, ModelChoice } from "@/server"
import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import {
  harnessDisplayLabel,
  harnessSelectionId,
  isCatalogHarness,
  isClientDefaultPlaceholder,
  type HarnessType,
} from "./profile"

export type HarnessReadiness = "unresolved" | "polling" | "ready" | "degraded" | "error"

export type HarnessSelectionState = {
  readonly connectionDeclaration?: HarnessConnectionRef
  readonly harness?: HarnessType
  readonly selectedModel?: string
  readonly selectedModelProvider?: string
  readonly dynamicModels?: readonly (HarnessOptionChoice & { providerId?: string })[] | null
  readonly readiness: HarnessReadiness
  readonly optionsLoading: boolean
  readonly configError?: string
  /** Chosen reasoning/thinking level, when the harness offers any. */
  readonly selectedThoughtLevel?: string
  readonly serviceTiers?: readonly HarnessOptionChoice[] | null
  readonly selectedServiceTier?: string
}

export function harnessMode(type?: HarnessType) {
  if (type) return "harness"
  return "unknown"
}

export function harnessDisplayName(state: Pick<HarnessSelectionState, "harness">) {
  if (!state.harness) return "Select agent"
  return harnessDisplayLabel(harnessSelectionId(state.harness))
}

export type HarnessModelChoice = HarnessOptionChoice & { providerId?: string }

function isTerminalModelOptionsError(state: Pick<HarnessSelectionState, "configError" | "optionsLoading">) {
  if (!state.configError || state.optionsLoading) return false
  return state.configError !== "Loading model options..." && state.configError !== "Selected model unavailable"
}

export function harnessModels(
  state: Pick<
    HarnessSelectionState,
    "harness" | "selectedModel" | "selectedModelProvider" | "dynamicModels" | "configError" | "optionsLoading"
  >,
): HarnessModelChoice[] {
  const raw = state.selectedModel ?? ""
  if (state.dynamicModels?.length) {
    if (!raw || state.dynamicModels.some((item) => item.id === raw)) return [...state.dynamicModels]
    if (isClientDefaultPlaceholder(raw)) return [...state.dynamicModels]
    return [
      { id: raw, name: raw, providerId: state.selectedModelProvider },
      ...state.dynamicModels,
    ]
  }
  if (isTerminalModelOptionsError(state)) return []
  if (isClientDefaultPlaceholder(raw)) return []
  return [{ id: raw, name: raw, providerId: state.selectedModelProvider }]
}

export function harnessModelKeyForSubmit(state: HarnessSelectionState): ModelChoice | undefined {
  if (!state.harness) return undefined
  if (state.harness.kind === "connection" && state.connectionDeclaration?.connectionId === state.harness.connectionId && state.connectionDeclaration.modelSelection?.status === "unsupported") return undefined
  const raw = state.selectedModel ?? ""
  if (connectionAllowsNoModel(state) && isClientDefaultPlaceholder(raw)) return undefined
  if (!raw) return undefined
  if (isClientDefaultPlaceholder(raw) && !state.dynamicModels?.some((item) => item.id === raw)) return undefined
  const match = harnessModels(state).find((item) => item.id === raw && (!state.selectedModelProvider || !item.providerId || item.providerId === state.selectedModelProvider))
  if (!match || match.connected === false) return undefined
  // A catalog harness submits a provider/model pair from the catalog; a bare
  // model id with no provider (a hydrated harness status) is not yet a key.
  const providerId = isCatalogHarness(state.harness)
    ? state.selectedModelProvider
    : state.selectedModelProvider ?? harnessSelectionId(state.harness)
  if (!providerId) return undefined
  return {
    providerId,
    modelId: raw,
    // Effort rides the model key's `variant` and travels with the prompt. A
    // harness turn is one `query()` and the SDK takes `effort` per query, so
    // the level travels WITH the prompt instead of being pushed at the running
    // process — which is why this needed no new transport.
    ...(state.selectedThoughtLevel ? { variant: state.selectedThoughtLevel } : {}),
  }
}

/**
 * The fast tier a prompt runs on, or `undefined` for the standard tier. A tier
 * chosen under a previous model is dropped rather than sent: the options it came
 * from belong to the model now selected.
 */
export function harnessServiceTierForSubmit(state: Pick<HarnessSelectionState, "serviceTiers" | "selectedServiceTier">) {
  const tier = state.selectedServiceTier
  return tier && state.serviceTiers?.some((option) => option.id === tier) ? tier : undefined
}

export function harnessModelNameForSubmit(state: HarnessSelectionState) {
  const model = harnessModelKeyForSubmit(state)
  if (!model) return undefined
  return harnessModels(state).find((item) => item.id === model.modelId && (!item.providerId || item.providerId === model.providerId))?.name
}

export function harnessReadyForSubmit(state: HarnessSelectionState) {
  if (state.configError || state.readiness === "error" || state.readiness === "degraded" || state.optionsLoading) return false
  return connectionAllowsNoModel(state) || !!harnessModelKeyForSubmit(state)
}

/** Only an enabled canonical declaration can permit an omitted model. */
export function connectionAllowsNoModel(state: HarnessSelectionState) {
  const connection = state.connectionDeclaration
  return state.harness?.kind === "connection" && connection?.connectionId === state.harness.connectionId
    && connection.enabled && connection.readiness !== "disabled" && connection.readiness !== "unavailable"
    && (connection.modelSelection?.status === "unsupported" || (connection.modelSelection?.status === "optional" && (!state.selectedModel || isClientDefaultPlaceholder(state.selectedModel))))
}
/** Discovery is not execution: a declared cold draft can initialize with its owner. */
export function draftConnectionAllowsNoModel(scope: string, state: HarnessSelectionState) {
  return !scope.startsWith("session:") && connectionAllowsNoModel(state)
}
