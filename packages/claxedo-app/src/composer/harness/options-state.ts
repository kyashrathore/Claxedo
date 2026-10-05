import type { HarnessOptionChoice, HarnessOptions, HarnessOptionsSource } from "@/server"
import {
  isNativeSdkHarness,
  isStaticCatalogOptions,
  type HarnessType,
} from "./profile"
import { modelOptionsUnavailableMessage, shouldShowModelOptionsStaleWarning } from "./store-policy"

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
}

type OptionsResponseInput = {
  type: HarnessType
  selectedModel?: string
  selectedThoughtLevel?: string
  modelOptional?: boolean
  preserveSelectedModel?: boolean
  sessionModel?: boolean
  payload: HarnessOptions
}

type ListedModels = NonNullable<HarnessOptions["models"]>

function optionsBase(input: OptionsResponseInput) {
  const thought = input.payload.thoughtLevels
  const kept = thought?.choices.some((level) => level.id === input.selectedThoughtLevel)
  return {
    optionsSource: input.payload.source,
    optionsStale: input.payload.stale,
    optionsLoading: false,
    thoughtLevels: thought?.choices ?? [],
    serviceTiers: input.payload.serviceTiers,
    selectedThoughtLevel: input.sessionModel || input.preserveSelectedModel || kept ? input.selectedThoughtLevel : thought?.current,
  } satisfies HarnessOptionsStatePatch
}

function loadedDecision(patch: HarnessOptionsStatePatch): HarnessOptionsDecision {
  return { patch: { ...patch, optionsLoading: false } }
}

function unresolvedDecision(input: OptionsResponseInput, base: HarnessOptionsStatePatch, dynamicModels: HarnessOptionsStatePatch["dynamicModels"]): HarnessOptionsDecision {
  const held = input.preserveSelectedModel || input.sessionModel ? input.selectedModel ?? "" : ""
  return loadedDecision({ ...base, dynamicModels, selectedModel: held, configError: modelOptionsUnavailableMessage({ stale: input.payload.stale }) })
}

function modellessDecision(input: OptionsResponseInput, base: HarnessOptionsStatePatch): HarnessOptionsDecision {
  const { payload } = input
  if (input.type.kind !== "connection" || payload.source !== "harness" || payload.stale || !(payload.offersOptions || input.modelOptional)) {
    return unresolvedDecision(input, base, [])
  }
  const resolved = payload.resolvedModel
  return loadedDecision({ ...base, dynamicModels: resolved ? [resolved] : [], selectedModel: resolved?.id ?? "", configError: undefined })
}

function listedModelsDecision(input: OptionsResponseInput, base: HarnessOptionsStatePatch, models: ListedModels): HarnessOptionsDecision {
  if (isStaticCatalogOptions(input.payload) && isNativeSdkHarness(input.type)) {
    return loadedDecision({ ...base, dynamicModels: [], selectedModel: "", configError: modelOptionsUnavailableMessage({ stale: true }) })
  }
  const current = input.selectedModel ?? ""
  const listed = models.choices.some((item) => item.id === current || item.resolvedModel === current)
  if ((input.preserveSelectedModel || input.sessionModel) && current && !listed) {
    return loadedDecision({ ...base, dynamicModels: models.choices, selectedModel: current, configError: "Selected model unavailable" })
  }
  const next = listed ? current : (models.current ?? models.choices[0]?.id ?? "")
  if (!next) return unresolvedDecision(input, base, models.choices)
  return loadedDecision({
    ...base,
    optionsStale: shouldShowModelOptionsStaleWarning({ stale: input.payload.stale, models: models.choices }),
    dynamicModels: models.choices,
    selectedModel: next,
    configError: undefined,
  })
}

export function applyHarnessOptionsResponse(input: OptionsResponseInput): HarnessOptionsDecision {
  const base = optionsBase(input)
  const models = input.payload.models
  return models ? listedModelsDecision(input, base, models) : modellessDecision(input, base)
}
