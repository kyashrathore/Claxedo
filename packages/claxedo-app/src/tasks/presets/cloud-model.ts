import { effectiveSessionModel } from "@claxedo/agent-runtime-contract"
import type { HarnessReference, ModelReference } from "@claxedo/tasks"
import type { ConfigurationDraft } from "./draft"

const CODEX_DEFAULT_MODEL: ModelReference = { providerID: "codex", modelID: "default" }

export function cloudPresetModel(harness: HarnessReference): ModelReference | undefined {
  if (harness.access !== "native") return undefined
  const declared = effectiveSessionModel(harness, undefined)
  if (declared) return declared
  return harness.id === "codex" ? CODEX_DEFAULT_MODEL : undefined
}

export function cloudConfiguration(harness: HarnessReference): ConfigurationDraft {
  return { harness, model: cloudPresetModel(harness) ?? null, effort: null }
}

export function isCloudPresetModel(configuration: ConfigurationDraft): boolean {
  const declared = configuration.harness ? cloudPresetModel(configuration.harness) : undefined
  return !!declared && declared.providerID === configuration.model?.providerID && declared.modelID === configuration.model.modelID
}
