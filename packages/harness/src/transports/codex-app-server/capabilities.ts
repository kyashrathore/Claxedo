import type { TransportCapabilities } from "../../contract"
import type { CodexModel } from "./models"

export function codexCapabilities(models: readonly CodexModel[]): TransportCapabilities {
  return {
    modelSelection: { status: "required", models: models.map((model) => ({ providerId: "codex", modelId: model.id,
      name: model.name, ...(model.description ? { description: model.description } : {}) })) },
    effortLevels: models.length ? { status: "resolved", models: models.map((model) => ({ modelID: model.id, levels: model.efforts,
      ...(model.defaultEffort ? { default: model.defaultEffort } : {}) })) } : { status: "unresolved", models: [] },
    instructionChannel: "thread-start", configOwner: "runtime",
    requests: { permissions: true, questions: true, elicitation: true },
    subagents: true,
    goals: { implemented: true, available: true, actions: ["pause", "resume", "delete"], recovery: "reconcile", optionalFields: ["tokenBudget", "tokensUsed", "timeUsedSeconds"] },
    todos: true, history: "store",
  }
}
