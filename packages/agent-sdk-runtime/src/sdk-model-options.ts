import { harnessEffortRefusal } from "@claxedo/agent-runtime-contract"
import { harnessEffortLevels } from "./harness-effort"
import type { AgentConfigOption } from "./index"

/** A model entry a harness reported for the picker. */
export type SdkModelEntry = {
  id: string
  name: string
  description?: string
  /** The model the harness runs when the session has selected none. */
  isDefault?: boolean
  /** Whether this model's provider has working credentials on the machine. */
  connected?: boolean
  /**
   * Harness-reported effort capability. It is per model, which is why the
   * thought-level option below is derived from the selected model rather than
   * cached against the harness. `defaultEffort` preserves the harness's own
   * default when it reports one.
   */
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  defaultEffort?: string
  /** The full model id an alias row runs (Claude's `opus` → `claude-opus-…`). */
  resolvedModel?: string
  /** Served and validated, but not offered in the picker. */
  hidden?: boolean
  /**
   * Faster tiers the model can run a turn on, beyond its standard one
   * (Codex's `serviceTiers`, e.g. `priority` named "Fast"). Per model, like
   * effort.
   */
  serviceTiers?: SdkServiceTier[]
}

export type SdkServiceTier = { id: string; name: string; description?: string }

const EFFORT_CONFIG_ID = "effort"
const SERVICE_TIER_CONFIG_ID = "service_tier"

/**
 * The effort a turn sends: `undefined` when none was requested, the requested
 * level when the model accepts it, and a thrown refusal otherwise.
 *
 * Never a silent drop. A harness handed a level its model lacks either
 * downgrades it on its own (the Claude SDK) or keeps the previous turn's level
 * (Codex), so dropping the request runs the turn at an effort the composer
 * never showed. An empty catalog cannot confirm anything, which is also a
 * refusal: callers pass a loaded catalog, not a cache that may be cold.
 */
export function requireTurnEffort(input: {
  harness: string
  models: readonly SdkModelEntry[]
  modelId: string | undefined
  requested: string | undefined
}): string | undefined {
  const requested = input.requested
  if (!requested) return undefined
  if (input.models.length === 0) {
    throw new Error(`The ${input.harness} model list is unavailable, so effort ${requested} cannot be confirmed`)
  }
  const model = catalogModel(input.models, input.modelId)
  if (model?.supportsEffort && model.supportedEffortLevels?.includes(requested)) return requested
  throw new Error(harnessEffortRefusal({
    harness: input.harness,
    catalog: harnessEffortLevels(input.models),
    modelID: model?.id ?? input.modelId,
    effort: requested,
  }) ?? `The ${input.harness} harness does not run ${input.modelId ?? "its default model"} at effort ${requested}`)
}

function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

/**
 * The selected model's reasoning-effort choice, as a `thought_level` config
 * option — the same category ACP defines, so one extractor on the app side
 * serves every harness.
 *
 * `undefined` when the model does not support effort, or offers fewer than two
 * levels: a single choice is not a choice, and surfacing it would spend a whole
 * disclosure section on something the user cannot change.
 */
export function thoughtLevelConfigOption(
  models: readonly SdkModelEntry[],
  currentModel: string | undefined,
): AgentConfigOption | undefined {
  // An empty model selection means the model catalog's advertised default.
  // A named model is resolved only by its own id.
  const model = catalogModel(models, currentModel)
  const levels = model?.supportsEffort ? model.supportedEffortLevels ?? [] : []
  if (levels.length < 2) return undefined
  // The model's declared default, which is what a turn naming no level runs at.
  // Absent when the harness declares none: the selection then stays with it.
  const current = model?.defaultEffort && levels.includes(model.defaultEffort) ? model.defaultEffort : undefined
  return {
    id: EFFORT_CONFIG_ID,
    name: "Effort",
    description: "How much reasoning effort the model should use",
    category: "thought_level",
    type: "select",
    ...(current ? { currentValue: current } : {}),
    selectOptions: levels.map((level) => ({ id: level, name: titleCase(level) })),
  }
}

/** The requested tier when the selected model offers it; otherwise the standard tier. */
export function resolveSupportedServiceTier(
  models: readonly SdkModelEntry[],
  modelId: string | undefined,
  requested: string | undefined,
) {
  if (!requested) return undefined
  return catalogModel(models, modelId)?.serviceTiers?.some((tier) => tier.id === requested) ? requested : undefined
}

/**
 * The selected model's faster tiers as a `service_tier` config option, or
 * `undefined` when it has none. The option lists only the non-standard tiers:
 * standard is the absence of a tier, which is what the app sends when fast is
 * off.
 */
export function serviceTierConfigOption(
  models: readonly SdkModelEntry[],
  currentModel: string | undefined,
): AgentConfigOption | undefined {
  const tiers = catalogModel(models, currentModel)?.serviceTiers ?? []
  if (tiers.length === 0) return undefined
  return {
    id: SERVICE_TIER_CONFIG_ID,
    name: "Speed",
    category: "service_tier",
    type: "select",
    selectOptions: tiers.map((tier) => ({ ...tier })),
  }
}

/** The row a model id names — by id, then as an alias's full model — or the default row when none is named. */
export function catalogModel(models: readonly SdkModelEntry[], modelId: string | undefined) {
  if (modelId) return models.find((item) => item.id === modelId) ?? models.find((item) => item.resolvedModel === modelId)
  return models.find((item) => item.isDefault) ?? models[0]
}

export function modelConfigOption(models: readonly SdkModelEntry[], currentModel?: string): AgentConfigOption {
  const defaultModel = models.find((item) => item.isDefault)?.id ?? models[0]?.id
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModel && models.some((item) => item.id === currentModel) ? currentModel : defaultModel,
    selectOptions: models
      .filter((item) => !item.hidden || item.id === currentModel)
      .map(({ isDefault: _isDefault, hidden: _hidden, resolvedModel: _resolvedModel, ...item }) => ({ ...item })),
  }
}
