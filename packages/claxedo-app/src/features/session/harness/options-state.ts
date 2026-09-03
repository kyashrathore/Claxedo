import {
  DEFAULT_HARNESS_MODEL,
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
  /** A live operator ACP answered, but owns model selection outside ACP. */
  managedDefault?: boolean
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
    // Operator ACP connections are deliberately open-ended: unlike the bundled
    // harnesses, their agents are not required to expose a `model` config
    // option. A fresh live response with other options proves the agent is up;
    // in that case model ownership stays with the agent (OpenClaw, for example,
    // uses its Gateway default). `default` is the runtime's protocol sentinel,
    // not a selectable row synthesized into the picker.
    if (input.type.startsWith("acp:") && input.payload.source === "harness" &&
      !input.payload.stale && input.payload.options.length > 0) {
      // Such an agent can still NAME the model it resolved for itself. That
      // named model IS the picker's single row, so the control reads the real
      // model and the prompt carries the real model id. Only an agent that
      // named nothing falls back to the client-side sentinel.
      const resolved = input.payload.resolvedModel
      if (resolved) {
        return {
          patch: {
            ...base,
            dynamicModels: [resolved],
            selectedModel: resolved.id,
            configError: undefined,
            optionsLoading: false,
          },
          retry: false,
          clearTries: true,
        }
      }
      return {
        patch: {
          ...base,
          dynamicModels: [],
          selectedModel: DEFAULT_HARNESS_MODEL.id,
          configError: undefined,
          optionsLoading: false,
        },
        managedDefault: true,
        retry: false,
        clearTries: true,
      }
    }
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
    retry,
    clearTries,
  }
}
