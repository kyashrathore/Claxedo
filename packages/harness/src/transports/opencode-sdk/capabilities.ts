import type { TransportCapabilities } from "../../contract"
import type { ModelEntry } from "./catalog-port"

export function openCodeCapabilities(models: readonly ModelEntry[]): TransportCapabilities {
  return {
    modelSelection: { status: "required", models: models.map((model) => ({ providerId: model.providerID,
      modelId: model.id, name: model.name ?? model.id })) },
    effortLevels: { status: "unresolved", models: [] },
    instructionChannel: "prompt-prefix", configOwner: "runtime",
    requests: { permissions: true, questions: true, elicitation: false },
    subagents: false,
    goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
    todos: false, history: "store", titles: "harness",
    pluginIntake: { mcp: "config", skills: "skill-dirs" },
    mcpTransports: { stdio: true, http: true, sse: true },
    timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "immediate" },
  }
}
