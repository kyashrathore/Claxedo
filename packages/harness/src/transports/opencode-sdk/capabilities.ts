import type { HarnessModelEffort } from "@claxedo/agent-runtime-contract"
import type { TransportCapabilities } from "../../contract"
import type { ModelEntry } from "./catalog-port"

function effortLevels(models: readonly ModelEntry[]): HarnessModelEffort[] {
  const levels = new Map<string, Set<string>>()
  for (const model of models) {
    if (!model.variants?.length) continue
    const known = levels.get(model.id) ?? new Set<string>()
    for (const variant of model.variants) known.add(variant)
    levels.set(model.id, known)
  }
  return [...levels].map(([modelID, variants]) => ({ modelID, levels: [...variants] }))
}

export function openCodeCapabilities(models: readonly ModelEntry[]): TransportCapabilities {
  return {
    modelSelection: { status: "required", models: models.map((model) => ({ providerId: model.providerID,
      modelId: model.id, name: model.name ?? model.id })) },
    effortLevels: models.length ? { status: "resolved", models: effortLevels(models) } : { status: "unresolved", models: [] },
    instructionChannel: "prompt-prefix", configOwner: "runtime",
    requests: { permissions: true, questions: true, elicitation: false },
    subagents: false,
    goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
    todos: false, history: "store",
  }
}
