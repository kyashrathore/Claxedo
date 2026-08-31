import type { AgentConfigOption } from "./index"
import type { AgentHarnessId } from "./harness-types"

export type NativeSdkHarnessId = Extract<AgentHarnessId, "claude" | "codex" | "cursor">

export const SDK_MODEL_CATALOG = {
  claude: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  codex: [
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-mini", name: "GPT-5.4-Mini" },
    { id: "gpt-5.2", name: "gpt-5.2" },
  ],
  cursor: [
    { id: "auto", name: "Auto" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
  ],
} as const satisfies Record<NativeSdkHarnessId, readonly { id: string; name: string; description?: string }[]>

export type SdkModelCatalog = typeof SDK_MODEL_CATALOG
export type SdkModelId<T extends NativeSdkHarnessId> = SdkModelCatalog[T][number]["id"]

/** A model entry servable to the picker or the explicit static catalog API. */
export type SdkModelEntry = {
  id: string
  name: string
  description?: string
  isDefault?: boolean
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

export function sdkModelOptions(harness: NativeSdkHarnessId): readonly SdkModelEntry[] {
  return SDK_MODEL_CATALOG[harness]
}

export function isSdkModelId<T extends NativeSdkHarnessId>(harness: T, model: string): model is SdkModelId<T> {
  return SDK_MODEL_CATALOG[harness].some((item) => item.id === model)
}

export function requireSdkModelId<T extends NativeSdkHarnessId>(harness: T, model: string): SdkModelId<T> {
  if (isSdkModelId(harness, model)) return model
  throw new Error(`${model} is not a known model for ${harness}`)
}

const EFFORT_CONFIG_ID = "effort"

/**
 * The Claude Agent SDK's closed effort union (`sdk.d.ts`: `EffortLevel`).
 * Mirrored rather than imported so this module stays harness-agnostic.
 */
export const SDK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type SdkEffortLevel = (typeof SDK_EFFORT_LEVELS)[number]

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
): SdkEffortLevel | undefined {
  if (!requested) return undefined
  if (!(SDK_EFFORT_LEVELS as readonly string[]).includes(requested)) return undefined
  return resolveSupportedEffort(models, modelId, requested) as SdkEffortLevel | undefined
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

export function sdkModelConfigOption(harness: NativeSdkHarnessId, currentModel?: string): AgentConfigOption {
  return modelConfigOption(sdkModelOptions(harness), currentModel)
}
