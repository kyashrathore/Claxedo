import type { DraftLaunch, TransportCapabilities } from "../../contract"
import type { CodexModel } from "./models"

export function codexCapabilities(models: readonly CodexModel[]): TransportCapabilities {
  return {
    modelSelection: { status: "required", models: models.map((model) => ({ providerId: "codex", modelId: model.id,
      name: model.name, ...(model.description ? { description: model.description } : {}) })) },
    effortLevels: models.length ? { status: "resolved", models: models.map((model) => ({ modelID: model.id, levels: model.efforts,
      ...(model.defaultEffort ? { default: model.defaultEffort } : {}) })) } : { status: "unresolved", models: [] },
    instructionChannel: "thread-start", configOwner: "runtime",
    requests: { permissions: true, questions: true, elicitation: true },
    steer: true, subagents: true,
    goals: { implemented: true, available: true, actions: ["pause", "resume", "delete"], recovery: "reconcile", optionalFields: ["tokenBudget", "tokensUsed", "timeUsedSeconds"] },
    fork: false, agents: false, commands: false, todos: true, history: "store", titles: "side-request",
    pluginIntake: { mcp: "config", skills: "plugin-dir" },
    mcpTransports: { stdio: true, http: true, sse: false },
    timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "after-active-turns" },
  }
}

export function codexCapabilityDraft(directory: string): DraftLaunch {
  return { workspaceId: "capability-probe", directory, locality: "local", owner: { kind: "machine-owner" },
    config: { harness: { id: "codex", access: "native" } },
    projection: { generation: "capability-probe", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: { providers: {}, secrets: {}, leaseGeneration: "capability-probe" } }
}
