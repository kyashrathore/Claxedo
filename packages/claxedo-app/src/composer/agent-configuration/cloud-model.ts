import { effectiveSessionModel } from "@claxedo/agent-runtime-contract"
import type { AgentConfiguration, AgentHarnessReference, AgentModelReference } from "./model"

const CODEX_DEFAULT_MODEL: AgentModelReference = { providerID: "codex", modelID: "default" }

export function cloudDefaultModel(harness: AgentHarnessReference): AgentModelReference | undefined {
  if (harness.access !== "native") return undefined
  const declared = effectiveSessionModel(harness, undefined)
  if (declared) return declared
  return harness.id === "codex" ? CODEX_DEFAULT_MODEL : undefined
}

export function cloudConfiguration(harness: AgentHarnessReference): AgentConfiguration {
  return { harness, model: cloudDefaultModel(harness) ?? null, effort: null }
}

export function isCloudDefaultModel(configuration: AgentConfiguration): boolean {
  const declared = configuration.harness ? cloudDefaultModel(configuration.harness) : undefined
  return !!declared && declared.providerID === configuration.model?.providerID && declared.modelID === configuration.model.modelID
}
