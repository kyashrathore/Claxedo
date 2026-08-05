import type { AgentConfigOptionRow } from "./index"
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

/** A model entry servable to the picker — live-listed from the harness or from the static fallback catalog. */
export type SdkModelEntry = {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  /**
   * Effort capability, straight off the Claude Agent SDK's `ModelInfo`. It is
   * PER MODEL — "Opus" offers levels that "Haiku" does not — which is why the
   * thought-level option below is derived from the selected model rather than
   * cached against the harness.
   */
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
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
  const model = models.find((item) => item.id === modelId)
  if (!model?.supportsEffort) return undefined
  return model.supportedEffortLevels?.includes(requested) ? requested as SdkEffortLevel : undefined
}

function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

/**
 * The selected model's reasoning-effort choice, as a `thought_level` config
 * option — the same category ACP defines and that codex-acp / claude-agent-acp
 * already emit, so one extractor on the app side serves every harness.
 *
 * `undefined` when the model does not support effort, or offers fewer than two
 * levels: a single choice is not a choice, and surfacing it would spend a whole
 * disclosure section on something the user cannot change.
 */
export function thoughtLevelConfigOption(
  models: readonly SdkModelEntry[],
  currentModel: string | undefined,
  currentEffort: string | undefined,
): AgentConfigOptionRow | undefined {
  // Same resolution `modelConfigOption` uses. `runtime.ts` maps the
  // "Default (recommended)" selection to `setModel("")`, so an empty current
  // model is the COMMON case, not an edge one — matching on id alone left the
  // effort row missing for exactly the default state.
  // Resolve the default the way `modelConfigOption` does, but ONLY for an
  // empty/absent selection — `runtime.ts` maps "Default (recommended)" to
  // `setModel("")`, so that is the common case, not an edge one. A non-empty id
  // we do not recognise must NOT silently adopt some other model's levels;
  // that would advertise an effort the turn cannot run at.
  const model = currentModel
    ? models.find((item) => item.id === currentModel)
    : models.find((item) => item.isDefault) ?? models[0]
  const levels = model?.supportsEffort ? model.supportedEffortLevels ?? [] : []
  if (levels.length < 2) return undefined
  // Never hand back a level this model does not offer. The SDK silently
  // downgrades an unsupported effort, which would leave the UI reporting a
  // setting the turn never actually ran with.
  const current = currentEffort && levels.includes(currentEffort) ? currentEffort : levels[0]
  return {
    id: EFFORT_CONFIG_ID,
    name: "Effort",
    description: "How much reasoning effort the model should use",
    category: "thought_level",
    type: "select",
    currentValue: current,
    // `selectOptions`, matching `modelConfigOption` above — that is this
    // runtime's shape. ACP agents put the same data in `options`; the app-side
    // extractor reads either, so both paths land on one Effort section.
    selectOptions: levels.map((level) => ({ id: level, name: titleCase(level) })),
  }
}

export function modelConfigOption(models: readonly SdkModelEntry[], currentModel?: string): AgentConfigOptionRow {
  const fallback = models.find((item) => item.isDefault)?.id ?? models[0]?.id
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModel && models.some((item) => item.id === currentModel) ? currentModel : fallback,
    selectOptions: models.map(({ isDefault: _isDefault, ...item }) => ({ ...item })),
  }
}

export function sdkModelConfigOption(harness: NativeSdkHarnessId, currentModel?: string): AgentConfigOptionRow {
  return modelConfigOption(sdkModelOptions(harness), currentModel)
}
