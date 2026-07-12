// target-layer: session
import type { ModelKey } from "@/features/session/composer/model-strategy"
import {
  DEFAULT_HARNESS_MODEL,
  HARNESS_DISPLAY_NAMES,
  effectiveHarnessModel,
  fixedHarnessModel,
  type HarnessType,
} from "./profile"

export type HarnessReadiness = "polling" | "ready" | "degraded" | "error"

export type HarnessSelectionState = {
  readonly harness: HarnessType
  readonly harnessBinary?: string
  readonly selectedModel?: string
  readonly dynamicModels?: readonly { id: string; name: string }[] | null
  readonly readiness: HarnessReadiness
  readonly optionsLoading: boolean
  readonly configError?: string
}

export function harnessMode(type?: HarnessType) {
  if (type === "opencode") return "opencode"
  if (type) return "harness"
  return "unknown"
}

export function harnessDisplayName(state: Pick<HarnessSelectionState, "harness" | "harnessBinary">) {
  const key = binaryName(state.harnessBinary || state.harness)
  return HARNESS_DISPLAY_NAMES[key] ?? key
}

export function harnessModels(state: Pick<HarnessSelectionState, "harness" | "selectedModel" | "dynamicModels">) {
  const selected = effectiveHarnessModel(state.harness, state.selectedModel)
  if (state.dynamicModels?.length) {
    if (!selected || state.dynamicModels.some((item) => item.id === selected)) return [...state.dynamicModels]
    return [
      { id: selected, name: selected === DEFAULT_HARNESS_MODEL.id ? DEFAULT_HARNESS_MODEL.name : selected },
      ...state.dynamicModels,
    ]
  }
  if (!selected) return []
  return [{ id: selected, name: selected === DEFAULT_HARNESS_MODEL.id ? DEFAULT_HARNESS_MODEL.name : selected }]
}

export function harnessModelKeyForSubmit(state: HarnessSelectionState): ModelKey | undefined {
  if (state.harness === "opencode") return undefined
  const fixed = fixedHarnessModel(state.harness)
  if (fixed) return { providerID: fixed.provider.id, modelID: fixed.id }
  const selected = effectiveHarnessModel(state.harness, state.selectedModel)
  if (!selected) return undefined
  if (!harnessModels(state).some((item) => item.id === selected)) return undefined
  return { providerID: state.harness, modelID: selected }
}

export function harnessModelNameForSubmit(state: HarnessSelectionState) {
  const model = harnessModelKeyForSubmit(state)
  if (!model) return undefined
  const fixed = fixedHarnessModel(state.harness)
  if (fixed?.id === model.modelID) return fixed.name
  return harnessModels(state).find((item) => item.id === model.modelID)?.name
}

export function harnessReadyForSubmit(state: HarnessSelectionState) {
  if (state.harness === "opencode") return true
  if (state.configError || state.readiness === "error" || state.optionsLoading) return false
  if (fixedHarnessModel(state.harness)) return true
  return !!harnessModelKeyForSubmit(state)
}

function binaryName(value: string) {
  return (value.includes("/") ? value.split("/").pop()! : value).replace(/\.exe$/i, "")
}
