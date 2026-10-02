import type { InitializeResponse } from "@agentclientprotocol/sdk"
import { asRecord, type GoalCapabilities, type GoalAction, type GoalOptionalField } from "@claxedo/agent-runtime-contract"

function methods(value: unknown, version: number): ReadonlySet<string> {
  const extension = asRecord(value)
  return extension?.version === version && Array.isArray(extension.methods)
    ? new Set(extension.methods.filter((method): method is string => typeof method === "string")) : new Set()
}

export function acpGroups(handshake: InitializeResponse) {
  const meta = asRecord(handshake._meta)
  const claxedo = methods(meta?.claxedo, 1)
  const goal = asRecord(meta?.goal)
  const goalMethods = methods(goal, 1)
  const goalsAvailable = ["session/goal/get", "session/goal/start", "session/goal/stop"].every((method) => goalMethods.has(method))
  const advertised = Array.isArray(goal?.actions) ? goal.actions : []
  const actions: GoalAction[] = []
  if (advertised.includes("pause") && advertised.includes("resume") &&
    goalMethods.has("session/goal/pause") && goalMethods.has("session/goal/resume")) actions.push("pause", "resume")
  if (advertised.includes("delete") && goalMethods.has("session/goal/delete")) actions.push("delete")
  const knownOptional: ReadonlySet<string> = new Set(["tokenBudget", "tokensUsed", "timeUsedSeconds", "iteration", "lastReason"])
  const optionalFields = Array.isArray(goal?.optionalFields) ? goal.optionalFields.filter((field): field is GoalOptionalField =>
    typeof field === "string" && knownOptional.has(field)) : []
  const goals: GoalCapabilities = goalsAvailable
    ? { implemented: true, available: true, actions, recovery: "reconcile", optionalFields }
    : { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] }
  return { steer: claxedo.has("session/steer"), agents: claxedo.has("session/agents/list"), goals }
}
