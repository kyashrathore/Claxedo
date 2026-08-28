import {
  extractModelsFromConfigOptions,
  extractThoughtLevelFromConfigOptions,
  isNativeSdkHarness,
  isStaticCatalogOptions,
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

function terminalEmptyOptionsDecision(input: {
  base: HarnessOptionsStatePatch
  payload: OptionsResponse
  tries: number
}): HarnessOptionsDecision {
  const retry = shouldRetryModelOptions({ stale: input.payload.stale, tries: input.tries })
  const patch = {
    ...input.base,
    dynamicModels: [],
    ...(retry ? {} : { selectedModel: "" }),
    configError: retry
      ? "Loading model options..."
      : modelOptionsUnavailableMessage({ stale: input.payload.stale }),
    optionsLoading: retry ? input.base.optionsLoading : false,
  } satisfies HarnessOptionsStatePatch
  return {
    patch,
    retry,
    clearTries: !input.payload.stale,
  }
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
    return terminalEmptyOptionsDecision({ base, payload: input.payload, tries: input.tries })
  }

  // Native SDK catalog backstops are not live options — fail immediately so
  // Cursor/Claude/Codex SDK auth and connectivity errors surface in the model
  // section instead of a static catalog row. Do not retry: the catalog will
  // not become live on its own.
  if (isStaticCatalogOptions(input.payload) && isNativeSdkHarness(input.type)) {
    return {
      patch: {
        ...base,
        dynamicModels: [],
        selectedModel: "",
        configError: modelOptionsUnavailableMessage({ stale: true }),
        optionsLoading: false,
      },
      retry: false,
      clearTries: false,
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
    const retry = shouldRetryModelOptions({ stale: input.payload.stale, tries: input.tries })
    return {
      patch: {
        ...base,
        dynamicModels: result.models,
        ...(retry ? {} : { selectedModel: "" }),
        configError: retry
          ? "Loading model options..."
          : modelOptionsUnavailableMessage({ stale: input.payload.stale }),
        optionsLoading: retry ? base.optionsLoading : false,
      },
      retry,
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
