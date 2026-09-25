import type { HarnessOptionChoice, HarnessOptions, HarnessOptionsSource } from "@/server"
import {
  isNativeSdkHarness,
  isStaticCatalogOptions,
  type HarnessType,
} from "./profile"
import {
  modelOptionsUnavailableMessage,
  shouldRetryModelOptions,
  shouldShowModelOptionsStaleWarning,
} from "./store-policy"

export type HarnessOptionsStatePatch = {
  dynamicModels?: readonly HarnessOptionChoice[] | null
  /** Reasoning/thinking levels this harness offers; `[]` when it offers none. */
  thoughtLevels?: readonly HarnessOptionChoice[] | null
  selectedThoughtLevel?: string
  serviceTiers?: readonly HarnessOptionChoice[] | null
  selectedModel?: string
  optionsSource?: HarnessOptionsSource
  optionsStale?: boolean
  optionsLoading?: boolean
  configError?: string
}

export type HarnessOptionsDecision = {
  patch: HarnessOptionsStatePatch
  retry: boolean
  clearTries: boolean
}

function terminalEmptyOptionsDecision(input: {
  base: HarnessOptionsStatePatch
  payload: HarnessOptions
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
  selectedThoughtLevel?: string
  modelOptional?: boolean
  preserveSelectedModel?: boolean
  payload: HarnessOptions
  tries: number
}): HarnessOptionsDecision {
  const models = input.payload.models
  const thought = input.payload.thoughtLevels
  // Effort rides `base` into EVERY branch below: a harness can answer with an
  // effort option while its model list is still loading or empty, and a model
  // branch that dropped it builds a control that "sometimes disappears".
  // `current` is the harness's default for the model (native SDKs report no
  // per-session effort), so it seeds the level and never replaces one the user
  // picked that this model still accepts.
  const kept = thought?.choices.some((level) => level.id === input.selectedThoughtLevel)
  const selectedThoughtLevel = kept ? input.selectedThoughtLevel : thought?.current
  const base = {
    optionsSource: input.payload.source,
    optionsStale: input.payload.stale,
    optionsLoading: input.payload.stale,
    thoughtLevels: thought?.choices ?? [],
    serviceTiers: input.payload.serviceTiers,
    // Written even when empty: a level this model does not offer must not stay
    // selected behind a hidden or changed control and ride the next prompt.
    selectedThoughtLevel,
  } satisfies HarnessOptionsStatePatch
  const clearTries = !input.payload.stale

  if (!models) {
    // Operator ACP connections are deliberately open-ended: unlike the bundled
    // harnesses, their agents are not required to expose a `model` config
    // option. A fresh live response with other options proves the agent is up;
    // in that case model ownership stays with the agent (OpenClaw, for example,
    // uses its Gateway default). Model omission is declared by the connection.
    if (input.type.kind === "connection" && input.payload.source === "harness" &&
      !input.payload.stale && (input.payload.offersOptions || input.modelOptional)) {
      // Such an agent can still NAME the model it resolved for itself. That
      // named model IS the picker's single row, so the control reads the real
      // model and the prompt carries the real model id. Only an agent that
      // named nothing leaves the selection absent.
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
          selectedModel: "",
          configError: undefined,
          optionsLoading: false,
        },
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
  if (input.preserveSelectedModel && current && !models.choices.some((item) => item.id === current)) {
    return {
      patch: {
        ...base,
        dynamicModels: models.choices,
        selectedModel: current,
        configError: "Selected model unavailable",
        optionsLoading: false,
      },
      retry: false,
      clearTries,
    }
  }
  const next = models.choices.some((item) => item.id === current)
    ? current
    : (models.current ?? models.choices[0]?.id ?? "")
  if (!next) {
    const retry = shouldRetryModelOptions({ stale: input.payload.stale, tries: input.tries })
    return {
      patch: {
        ...base,
        dynamicModels: models.choices,
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
        models: models.choices,
      }),
      dynamicModels: models.choices,
      selectedModel: next,
      configError: undefined,
      optionsLoading: retry ? base.optionsLoading : false,
    },
    retry,
    clearTries,
  }
}
