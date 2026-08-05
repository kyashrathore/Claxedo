import {
  effectiveHarnessModel,
  extractModelsFromConfigOptions,
  extractThoughtLevelFromConfigOptions,
  type HarnessModelOption,
  type HarnessType,
  type OptionsResponse,
  type OptionsSource,
} from "./profile"
import {
  modelOptionsUnavailableMessage,
  shouldRetryModelOptions,
  shouldShowModelOptionsStaleWarning,
} from "./store-policy"

export type HarnessOptionsStatePatch = {
  dynamicModels?: HarnessModelOption[] | null
  /** Reasoning/thinking levels this harness offers; `[]` when it offers none. */
  thoughtLevels?: HarnessModelOption[] | null
  selectedThoughtLevel?: string
  selectedModel?: string
  optionsSource?: OptionsSource
  optionsStale?: boolean
  optionsLoading?: boolean
  configError?: string
}

export type HarnessOptionsDecision = {
  patch: HarnessOptionsStatePatch
  saveModel?: string
  retry: boolean
  clearTries: boolean
}

export function applyHarnessOptionsResponse(input: {
  type: HarnessType
  selectedModel?: string
  preserveSelectedModel?: boolean
  payload: OptionsResponse
  tries: number
}): HarnessOptionsDecision {
  const result = extractModelsFromConfigOptions(input.payload.options)
  // Extracted independently of the model result and folded into `base` so it
  // rides EVERY branch below. A harness can answer with an effort option while
  // its model list is still loading or empty, and the model branches return
  // early — dropping effort there is how a control that "sometimes disappears"
  // gets built.
  const thought = extractThoughtLevelFromConfigOptions(input.payload.options)
  const base = {
    optionsSource: input.payload.source,
    optionsStale: input.payload.stale,
    optionsLoading: input.payload.stale,
    thoughtLevels: thought?.levels ?? [],
    ...(thought?.current !== undefined ? { selectedThoughtLevel: thought.current } : {}),
  } satisfies HarnessOptionsStatePatch
  const clearTries = !input.payload.stale

  if (!result || result.models.length === 0) {
    const fallback = input.payload.stale
      ? undefined
      : effectiveHarnessModel(input.type, input.selectedModel)
    const retry = shouldRetryModelOptions({ stale: input.payload.stale, tries: input.tries })
    const patch = {
      ...base,
      dynamicModels: [],
      ...(fallback !== undefined ? { selectedModel: fallback } : {}),
      configError: retry
        ? "Loading model options..."
        : modelOptionsUnavailableMessage({ stale: input.payload.stale }),
      optionsLoading: retry ? base.optionsLoading : false,
    } satisfies HarnessOptionsStatePatch
    return {
      patch,
      ...(fallback ? { saveModel: fallback } : {}),
      retry,
      clearTries,
    }
  }

  const current = input.selectedModel ?? ""
  if (input.preserveSelectedModel && current && !result.models.some((item) => item.id === current)) {
    return {
      patch: {
        ...base,
        dynamicModels: result.models,
        selectedModel: current,
        configError: "Selected model unavailable",
        optionsLoading: false,
      },
      retry: false,
      clearTries,
    }
  }
  const next = result.models.some((item) => item.id === current)
    ? current
    : (result.currentModel ?? result.models[0]?.id ?? "")
  if (!next) {
    const fallback = effectiveHarnessModel(input.type, input.selectedModel)
    return {
      patch: {
        ...base,
        dynamicModels: result.models,
        selectedModel: fallback,
        configError: input.payload.stale ? "Loading model options..." : "No model options available",
      },
      ...(fallback ? { saveModel: fallback } : {}),
      retry: false,
      clearTries,
    }
  }

  const retry = shouldRetryModelOptions({ stale: input.payload.stale, tries: input.tries })
  return {
    patch: {
      ...base,
      optionsStale: shouldShowModelOptionsStaleWarning({
        stale: input.payload.stale,
        models: result.models,
      }),
      dynamicModels: result.models,
      selectedModel: next,
      configError: undefined,
      optionsLoading: retry ? base.optionsLoading : false,
    },
    saveModel: next,
    retry,
    clearTries,
  }
}
