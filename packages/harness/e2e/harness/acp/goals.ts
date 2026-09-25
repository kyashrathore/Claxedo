type GoalStatus = "active" | "paused" | "complete"

type Goal = {
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  iteration: number
}

const methods = [
  "session/goal/get",
  "session/goal/start",
  "session/goal/stop",
  "session/goal/pause",
  "session/goal/resume",
  "session/goal/delete",
]

export const scriptedGoalExtension = {
  version: 1,
  methods,
  actions: ["pause", "resume", "delete"],
  optionalFields: ["iteration"],
}

export function refuseGoalStart(dir: string) {
  fs.writeFileSync(path.join(dir, "refuse-goal-start"), "refused")
}

export function scriptedGoals(dir: string) {
  const goals = new Map<string, Goal>()
  return (method: string, params: Record<string, unknown>): Record<string, unknown> => {
    const sessionId = params.sessionId
    if (typeof sessionId !== "string") throw new Error("Goal request has no sessionId")
    const current = goals.get(sessionId)
    if (method === "session/goal/get") return { goal: current ?? null }
    if (method === "session/goal/delete") {
      goals.delete(sessionId)
      return { goal: null }
    }
    const now = Date.now()
    if (method === "session/goal/start") {
      if (fs.existsSync(path.join(dir, "refuse-goal-start"))) throw new Error("Scripted ACP refused Goal start")
      if (typeof params.objective !== "string" || !params.objective.trim()) throw new Error("Goal objective is required")
      const goal: Goal = { objective: params.objective, status: "active", createdAt: now, updatedAt: now, iteration: 0 }
      goals.set(sessionId, goal)
      return { goal }
    }
    if (!current) throw new Error("Goal does not exist")
    const status: GoalStatus = method === "session/goal/pause" ? "paused"
      : method === "session/goal/resume" ? "active"
      : method === "session/goal/stop" ? "complete"
      : (() => { throw new Error(`Unknown Goal method ${method}`) })()
    const goal = { ...current, status, updatedAt: Math.max(now, current.updatedAt + 1) }
    goals.set(sessionId, goal)
    return { goal }
  }
}
import fs from "node:fs"
import path from "node:path"
