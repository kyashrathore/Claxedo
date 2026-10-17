import type { EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import { isHarnessEffortLevel, type AgentConfigOption } from "@claxedo/agent-runtime-contract"
import { modelAndEffortOptions } from "../../contract"
import { TransportError } from "../../contract/errors"

export function claudeCatalogModel(models: readonly ModelInfo[], modelId?: string): ModelInfo | undefined {
  return models.find((model) => model.value === modelId) ?? models.find((model) => model.resolvedModel === modelId)
    ?? (modelId === undefined ? models.find((model) => model.value === "default") : undefined)
}

export function requiredClaudeEffort(models: readonly ModelInfo[], modelId: string, requested?: string | null): EffortLevel | undefined {
  if (!requested) return undefined
  const row = claudeCatalogModel(models, modelId)
  if (isHarnessEffortLevel(requested) && row?.supportsEffort && row.supportedEffortLevels?.some((level) => level === requested)) return requested
  throw new TransportError("claude", "configuration", `Claude does not run ${row?.value ?? modelId} at effort ${requested}`)
}

export function modelOptions(models: readonly ModelInfo[], currentModel: string): AgentConfigOption[] {
  if (!models.length) return []
  const selected = claudeCatalogModel(models, currentModel)
  return modelAndEffortOptions({ selected: selected?.value,
    models: models.map((model) => ({ id: model.value, name: model.displayName, description: model.description,
      ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}) })),
    efforts: selected?.supportsEffort ? selected.supportedEffortLevels : undefined })
}
