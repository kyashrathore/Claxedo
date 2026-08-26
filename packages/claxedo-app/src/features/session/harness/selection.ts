import type { ModelKey } from "@/features/session/composer/model-strategy"
import {
  DEFAULT_HARNESS_MODEL,
  HARNESS_DISPLAY_NAMES,
  effectiveHarnessModel,
  harnessDisplayLabel,
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

export function harnessModels(
  state: Pick<HarnessSelectionState, "harness" | "selectedModel" | "selectedModelProvider" | "dynamicModels">,
): HarnessModelChoice[] {
  const selected = effectiveHarnessModel(state.harness, state.selectedModel)
  if (state.dynamicModels?.length) {
    if (!selected || state.dynamicModels.some((item) => item.id === selected)) return [...state.dynamicModels]
    return [
      {
        id: selected,
        name: selected === DEFAULT_HARNESS_MODEL.id ? DEFAULT_HARNESS_MODEL.name : selected,
        providerID: state.selectedModelProvider,
      },
      ...state.dynamicModels,
    ]
  }
  if (!selected) return []
  return [
    {
      id: selected,
      name: selected === DEFAULT_HARNESS_MODEL.id ? DEFAULT_HARNESS_MODEL.name : selected,
      providerID: state.selectedModelProvider,
    },
  ]
}

export function harnessModelKeyForSubmit(state: HarnessSelectionState): ModelKey | undefined {
  if (state.harness === "opencode") return undefined
  const selected = effectiveHarnessModel(state.harness, state.selectedModel)
  if (!selected) return undefined
  const match = harnessModels(state).find(
    (item) =>
      item.id === selected &&
      (!state.selectedModelProvider || !item.providerID || item.providerID === state.selectedModelProvider),
  )
  if (!match) return undefined
  const providerID = state.harness === "pi" ? state.selectedModelProvider : state.harness
  if (!providerID) return undefined
  return {
    providerID,
    modelID: selected,
    // Effort rides the model key's `variant`, the same field opencode uses. A
    // harness turn is one `query()` and the SDK takes `effort` per query, so
    // the level travels WITH the prompt instead of being pushed at the running
    // process — which is why this needed no new transport.
    ...(state.selectedThoughtLevel ? { variant: state.selectedThoughtLevel } : {}),
  }
}

export function harnessModelNameForSubmit(state: HarnessSelectionState) {
  const model = harnessModelKeyForSubmit(state)
  if (!model) return undefined
  return harnessModels(state).find(
    (item) => item.id === model.modelID && (!item.providerID || item.providerID === model.providerID),
  )?.name
}

export function harnessReadyForSubmit(state: HarnessSelectionState) {
  if (state.harness === "opencode") return true
  if (state.configError || state.readiness === "error" || state.readiness === "degraded" || state.optionsLoading)
    return false
  return !!harnessModelKeyForSubmit(state)
}

function binaryName(value: string) {
  return (value.includes("/") ? value.split("/").pop()! : value).replace(/\.exe$/i, "")
}
