import type { ModelKey } from "@/features/session/composer/model-strategy"
import {
  DEFAULT_HARNESS_MODEL,
  HARNESS_DISPLAY_NAMES,
  effectiveHarnessModel,
  harnessDisplayLabel,
  isClientDefaultPlaceholder,
  type HarnessModelOption,
  type HarnessType,
} from "./profile"

export type HarnessReadiness = "polling" | "ready" | "degraded" | "error"

export type HarnessSelectionState = {
  readonly harness: HarnessType
  readonly harnessBinary?: string
  readonly selectedModel?: string
  readonly selectedModelProvider?: string
  readonly dynamicModels?: readonly (HarnessModelOption & { providerID?: string })[] | null
  readonly readiness: HarnessReadiness
  readonly optionsLoading: boolean
  readonly configError?: string
  /** Chosen reasoning/thinking level, when the harness offers any. */
  readonly selectedThoughtLevel?: string
}

export function harnessMode(type?: HarnessType) {
  if (type === "opencode") return "opencode"
  if (type) return "harness"
  return "unknown"
}

export function harnessDisplayName(state: Pick<HarnessSelectionState, "harness" | "harnessBinary">) {
  const key = binaryName(state.harnessBinary || state.harness)
  if (HARNESS_DISPLAY_NAMES[key]) return HARNESS_DISPLAY_NAMES[key]
  // Operator ACP connections get their slug title-cased; anything else keeps
  // the historical behavior of echoing the binary/key verbatim.
  if (state.harness.startsWith("acp:")) return harnessDisplayLabel(state.harness)
  return key
}

export type HarnessModelChoice = HarnessModelOption & { providerID?: string }

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
      { id: raw, name: raw, providerID: state.selectedModelProvider },
      ...state.dynamicModels,
    ]
  }
  if (isTerminalModelOptionsError(state)) return []
  if (isClientDefaultPlaceholder(raw)) return []
  return [{ id: raw, name: raw, providerID: state.selectedModelProvider }]
}

export function harnessModelKeyForSubmit(state: HarnessSelectionState): ModelKey | undefined {
  if (state.harness === "opencode") return undefined
  const raw = state.selectedModel ?? ""
  if (!raw) return undefined
  if (harnessUsesManagedDefaultModel(state)) {
    return {
      providerID: state.harness,
      modelID: DEFAULT_HARNESS_MODEL.id,
      ...(state.selectedThoughtLevel ? { variant: state.selectedThoughtLevel } : {}),
    }
  }
  if (isClientDefaultPlaceholder(raw) && !state.dynamicModels?.some((item) => item.id === raw)) return undefined
  const match = harnessModels(state).find((item) => item.id === raw && (!state.selectedModelProvider || !item.providerID || item.providerID === state.selectedModelProvider))
  if (!match) return undefined
  const providerID = state.harness === "pi" ? state.selectedModelProvider : state.harness
  if (!providerID) return undefined
  return {
    providerID,
    modelID: raw,
    // Effort rides the model key's `variant`, the same field opencode uses. A
    // harness turn is one `query()` and the SDK takes `effort` per query, so
    // the level travels WITH the prompt instead of being pushed at the running
    // process — which is why this needed no new transport.
    ...(state.selectedThoughtLevel ? { variant: state.selectedThoughtLevel } : {}),
  }
}

/**
 * A live operator ACP can expose useful config while leaving model selection to
 * the agent itself. This exact state is distinct from unresolved (`null`),
 * loading, and failed option discovery, so it never masks a broken connection.
 */
export function harnessUsesManagedDefaultModel(state: HarnessSelectionState) {
  return state.harness.startsWith("acp:") &&
    state.selectedModel === DEFAULT_HARNESS_MODEL.id &&
    Array.isArray(state.dynamicModels) && state.dynamicModels.length === 0 &&
    !state.optionsLoading && !state.configError
}

export function harnessModelNameForSubmit(state: HarnessSelectionState) {
  const model = harnessModelKeyForSubmit(state)
  if (!model) return undefined
  return harnessModels(state).find((item) => item.id === model.modelID && (!item.providerID || item.providerID === model.providerID))?.name
}

export function harnessReadyForSubmit(state: HarnessSelectionState) {
  if (state.harness === "opencode") return true
  if (state.configError || state.readiness === "error" || state.readiness === "degraded" || state.optionsLoading) return false
  return !!harnessModelKeyForSubmit(state)
}

function binaryName(value: string) {
  return (value.includes("/") ? value.split("/").pop()! : value).replace(/\.exe$/i, "")
}
