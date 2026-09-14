import { isHarnessEffortLevel, type HarnessEffortLevel } from "@claxedo/agent-runtime-contract"
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
}

const EFFORT_CONFIG_ID = "effort"

/**
 * The effort to send with a turn, or `undefined` for "let the model decide".
 *
 * Validated against the SELECTED MODEL's own `supportedEffortLevels` rather
 * than cast. Two reasons, and both are ways the UI would otherwise lie:
 * the SDK silently downgrades a level the model does not support, so the turn
 * would run at an effort the composer never showed; and a level persisted under
 * a previous model survives a model switch, so "max" chosen on Opus must not
 * leak onto a model that tops out lower.
 */
export function resolveTurnEffort(
  models: readonly SdkModelEntry[],
  modelId: string | undefined,
  requested: string | undefined,
): HarnessEffortLevel | undefined {
  if (!requested || !isHarnessEffortLevel(requested)) return undefined
  const resolved = resolveSupportedEffort(models, modelId, requested)
  return resolved && isHarnessEffortLevel(resolved) ? resolved : undefined
}

/** Resolves a harness-advertised effort without imposing another harness's union. */
export function resolveSupportedEffort(
  models: readonly SdkModelEntry[],
  modelId: string | undefined,
  requested: string | undefined,
) {
  if (!requested) return undefined
  const model = selectedEffortModel(models, modelId)
  if (!model?.supportsEffort) return undefined
  return model.supportedEffortLevels?.includes(requested) ? requested : undefined
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
  currentEffort: string | undefined,
): AgentConfigOption | undefined {
  // An empty model selection means the model catalog's advertised default.
  // A named model is resolved only by its own id.
  const model = selectedEffortModel(models, currentModel)
  const levels = model?.supportsEffort ? model.supportedEffortLevels ?? [] : []
  if (levels.length < 2) return undefined
  // The current value describes an explicit supported selection or the model's
  // declared default. An absent value leaves selection with the model.
  const current = currentEffort && levels.includes(currentEffort)
    ? currentEffort
    : model?.defaultEffort && levels.includes(model.defaultEffort)
    ? model.defaultEffort
    : undefined
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

function selectedEffortModel(models: readonly SdkModelEntry[], modelId: string | undefined) {
  if (modelId) return models.find((item) => item.id === modelId)
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
    selectOptions: models.map(({ isDefault: _isDefault, ...item }) => ({ ...item })),
  }
}
