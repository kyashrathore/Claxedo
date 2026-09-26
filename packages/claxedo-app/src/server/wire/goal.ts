import { isRuntimeGoalStatus } from "@claxedo/agent-runtime-contract"
import { ServerError } from "../errors"
import type { GoalAction, SessionGoal, SessionGoalState } from "../types"
import { isRecord } from "@claxedo/helpers/guards"

export const GOAL_UNAVAILABLE = "goal_runtime_unavailable"

export const GOAL_ACTION_ROUTES: Readonly<Record<GoalAction, { readonly method: "POST" | "DELETE"; readonly suffix: string }>> = {
  pause: { method: "POST", suffix: "/goal/pause" },
  resume: { method: "POST", suffix: "/goal/resume" },
  remove: { method: "DELETE", suffix: "/goal" },
  stop: { method: "POST", suffix: "/goal/stop" },
}

const GOAL_ACTIONS: Readonly<Record<string, GoalAction>> = { pause: "pause", resume: "resume", delete: "remove" }

export function goalFromWire(value: unknown): SessionGoal | undefined {
  if (!isRecord(value)) return undefined
  const { sessionId, objective, status, createdAt, updatedAt } = value
  if (typeof sessionId !== "string" || typeof objective !== "string" || !isRuntimeGoalStatus(status)) return undefined
  if (typeof createdAt !== "number" || typeof updatedAt !== "number") return undefined
  return value as SessionGoal
}

export function goalStateFromWire(body: unknown): SessionGoalState {
  const row = isRecord(body) ? body : {}
  const capabilities = isRecord(row.capabilities) ? row.capabilities : {}
  const offered = capabilities.available === true && Array.isArray(capabilities.actions) ? capabilities.actions : []
  const actions = offered.flatMap((action) => (typeof action === "string" && GOAL_ACTIONS[action] ? [GOAL_ACTIONS[action]] : []))
  return { goal: goalFromWire(row.goal), actions, available: capabilities.available === true && capabilities.implemented === true }
}

export function goalMutationFromWire(body: unknown): SessionGoal | undefined {
  const goal = isRecord(body) ? body.goal : undefined
  if (goal === null || goal === undefined) return undefined
  const parsed = goalFromWire(goal)
  if (!parsed) throw new ServerError({ class: "internal", message: "The goal route answered with a malformed goal" })
  return parsed
}
