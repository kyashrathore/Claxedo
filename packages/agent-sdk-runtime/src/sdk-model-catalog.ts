import type { AgentConfigOptionRow } from "./index"
import type { AgentHarnessId } from "./harness-types"

export type NativeSdkHarnessId = Extract<AgentHarnessId, "claude" | "codex" | "cursor">

export const SDK_MODEL_CATALOG = {
  claude: [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
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
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
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
