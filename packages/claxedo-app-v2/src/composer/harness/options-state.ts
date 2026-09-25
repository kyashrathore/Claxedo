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

function optionsBase(input: OptionsResponseInput) {
  const thought = input.payload.thoughtLevels
  const kept = thought?.choices.some((level) => level.id === input.selectedThoughtLevel)
  return {
    optionsSource: input.payload.source,
    optionsStale: input.payload.stale,
    optionsLoading: input.payload.stale,
    thoughtLevels: thought?.choices ?? [],
    serviceTiers: input.payload.serviceTiers,
    selectedThoughtLevel: kept ? input.selectedThoughtLevel : thought?.current,
  } satisfies HarnessOptionsStatePatch
}

function settled(patch: HarnessOptionsStatePatch, clearTries: boolean): HarnessOptionsDecision {
  return { patch: { ...patch, optionsLoading: false }, retry: false, clearTries }
}

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
  const { payload } = input
  if (input.type.kind !== "connection" || payload.source !== "harness" || payload.stale || !(payload.offersOptions || input.modelOptional)) {
    return unresolvedDecision(input, base, [])
  }
  const resolved = payload.resolvedModel
  return settled({ ...base, dynamicModels: resolved ? [resolved] : [], selectedModel: resolved?.id ?? "", configError: undefined }, true)
}

function listedModelsDecision(input: OptionsResponseInput, base: HarnessOptionsStatePatch, models: ListedModels): HarnessOptionsDecision {
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
