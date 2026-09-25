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

type OptionsResponseInput = {
  type: HarnessType
  selectedModel?: string
  selectedThoughtLevel?: string
  modelOptional?: boolean
  preserveSelectedModel?: boolean
  payload: HarnessOptions
  tries: number
}

type ListedModels = NonNullable<HarnessOptions["models"]>

// Effort rides `base` into EVERY branch: a harness can answer with an effort
// option while its model list is still loading or empty, and a model branch
// that dropped it builds a control that "sometimes disappears". `current` is
// the harness's default for the model (native SDKs report no per-session
// effort), so it seeds the level and never replaces one the user picked that
// this model still accepts.
function optionsBase(input: OptionsResponseInput) {
  const thought = input.payload.thoughtLevels
  const kept = thought?.choices.some((level) => level.id === input.selectedThoughtLevel)
  return {
    optionsSource: input.payload.source,
    optionsStale: input.payload.stale,
    optionsLoading: input.payload.stale,
    thoughtLevels: thought?.choices ?? [],
    serviceTiers: input.payload.serviceTiers,
    // Written even when empty: a level this model does not offer must not stay
    // selected behind a hidden or changed control and ride the next prompt.
    selectedThoughtLevel: kept ? input.selectedThoughtLevel : thought?.current,
  } satisfies HarnessOptionsStatePatch
}

function settled(patch: HarnessOptionsStatePatch, clearTries: boolean): HarnessOptionsDecision {
  return { patch: { ...patch, optionsLoading: false }, retry: false, clearTries }
}

/** No model to select yet: retry a stale answer up to the limit, then say the options are unavailable. */
function unresolvedDecision(input: OptionsResponseInput, base: HarnessOptionsStatePatch, dynamicModels: HarnessOptionsStatePatch["dynamicModels"]): HarnessOptionsDecision {
  const retry = shouldRetryModelOptions({ stale: input.payload.stale, tries: input.tries })
  const patch = {
    ...base,
    dynamicModels,
    ...(retry ? {} : { selectedModel: "" }),
    configError: retry ? "Loading model options..." : modelOptionsUnavailableMessage({ stale: input.payload.stale }),
    optionsLoading: retry ? base.optionsLoading : false,
  } satisfies HarnessOptionsStatePatch
  return { patch, retry, clearTries: !input.payload.stale }
}

function modellessDecision(input: OptionsResponseInput, base: HarnessOptionsStatePatch): HarnessOptionsDecision {
  // Operator ACP connections are deliberately open-ended: unlike the bundled
  // harnesses, their agents are not required to expose a `model` config
  // option. A fresh live response with other options proves the agent is up;
  // in that case model ownership stays with the agent (OpenClaw, for example,
  // uses its Gateway default). Model omission is declared by the connection.
  const { payload } = input
  if (input.type.kind !== "connection" || payload.source !== "harness" || payload.stale || !(payload.offersOptions || input.modelOptional)) {
    return unresolvedDecision(input, base, [])
  }
  // Such an agent can still NAME the model it resolved for itself. That
  // named model IS the picker's single row, so the control reads the real
  // model and the prompt carries the real model id. Only an agent that
  // named nothing leaves the selection absent.
  const resolved = payload.resolvedModel
  return settled({ ...base, dynamicModels: resolved ? [resolved] : [], selectedModel: resolved?.id ?? "", configError: undefined }, true)
}

function listedModelsDecision(input: OptionsResponseInput, base: HarnessOptionsStatePatch, models: ListedModels): HarnessOptionsDecision {
  // Native SDK catalog backstops are not live options — fail immediately so
  // Cursor/Claude/Codex SDK auth and connectivity errors surface in the model
  // section instead of a static catalog row. Do not retry: the catalog will
  // not become live on its own.
  if (isStaticCatalogOptions(input.payload) && isNativeSdkHarness(input.type)) {
    return settled({ ...base, dynamicModels: [], selectedModel: "", configError: modelOptionsUnavailableMessage({ stale: true }) }, false)
  }
  const clearTries = !input.payload.stale
  const current = input.selectedModel ?? ""
  const listed = models.choices.some((item) => item.id === current)
  if (input.preserveSelectedModel && current && !listed) {
    return settled({ ...base, dynamicModels: models.choices, selectedModel: current, configError: "Selected model unavailable" }, clearTries)
  }
  const next = listed ? current : (models.current ?? models.choices[0]?.id ?? "")
  if (!next) return unresolvedDecision(input, base, models.choices)
  const retry = shouldRetryModelOptions({ stale: input.payload.stale, tries: input.tries })
  return {
    patch: {
      ...base,
      optionsStale: shouldShowModelOptionsStaleWarning({ stale: input.payload.stale, models: models.choices }),
      dynamicModels: models.choices,
      selectedModel: next,
      configError: undefined,
      optionsLoading: retry ? base.optionsLoading : false,
    },
    retry,
    clearTries,
  }
}

export function applyHarnessOptionsResponse(input: OptionsResponseInput): HarnessOptionsDecision {
  const base = optionsBase(input)
  const models = input.payload.models
  return models ? listedModelsDecision(input, base, models) : modellessDecision(input, base)
}
