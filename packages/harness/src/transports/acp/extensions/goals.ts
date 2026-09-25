import type { RuntimeGoalSnapshot, AgentGoalMutationResult } from "@claxedo/agent-runtime-contract"
import type { AcpEntry } from "../index"
import { AcpTransportError } from "../errors"

function goalSnapshot(sessionId: string, response: Record<string, unknown>): RuntimeGoalSnapshot | null {
  if (response.goal === null) return null
  const goal = response.goal
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) throw new AcpTransportError("protocol", "ACP Goal response is invalid")
  const row = Object.fromEntries(Object.entries(goal))
  if (typeof row.objective !== "string" || !goalStatus(row.status) ||
    typeof row.createdAt !== "number" || typeof row.updatedAt !== "number") throw new AcpTransportError("protocol", "ACP Goal response is invalid")
  return { sessionId, objective: row.objective, status: row.status,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(typeof row.iteration === "number" ? { iteration: row.iteration } : {}),
    ...(typeof row.lastReason === "string" ? { lastReason: row.lastReason } : {}),
    ...(typeof row.tokenBudget === "number" ? { tokenBudget: row.tokenBudget } : {}),
    ...(typeof row.tokensUsed === "number" ? { tokensUsed: row.tokensUsed } : {}),
    ...(typeof row.timeUsedSeconds === "number" ? { timeUsedSeconds: row.timeUsedSeconds } : {}) }
}

function goalStatus(value: unknown): value is RuntimeGoalSnapshot["status"] {
  return value === "active" || value === "paused" || value === "blocked" || value === "limited" || value === "complete"
}

export function acpGoalOperations(entry: (session: AcpEntry["session"]) => AcpEntry) {
  const request = async (session: AcpEntry["session"], method: string, extra: Record<string, unknown> = {}) => {
    const current = entry(session)
    return goalSnapshot(session.binding.sessionId, await current.peer.agent.extMethod(method,
      { sessionId: session.binding.upstreamSessionId, ...extra }))
  }
  const mutate = async (session: AcpEntry["session"], method: string, extra: Record<string, unknown> = {}): Promise<AgentGoalMutationResult> => {
    try {
      const goal = await request(session, method, extra)
      if (goal === null) throw new AcpTransportError("protocol", "ACP Goal mutation returned no Goal")
      return { ok: true, goal }
    }
    catch (error) { return { ok: false, status: "failed", message: error instanceof Error ? error.message : String(error) } }
  }
  return {
    read: (session: AcpEntry["session"]) => request(session, "session/goal/get"),
    start: (session: AcpEntry["session"], objective: string) => mutate(session, "session/goal/start", { objective }),
    pause: (session: AcpEntry["session"]) => mutate(session, "session/goal/pause"),
    resume: (session: AcpEntry["session"]) => mutate(session, "session/goal/resume"),
    stop: (session: AcpEntry["session"]) => mutate(session, "session/goal/stop"),
    delete: async (session: AcpEntry["session"]): Promise<AgentGoalMutationResult<null>> => {
      try {
        const goal = await request(session, "session/goal/delete")
        if (goal !== null) throw new AcpTransportError("protocol", "ACP Goal delete returned a live Goal")
        return { ok: true, goal: null }
      } catch (error) { return { ok: false, status: "failed", message: error instanceof Error ? error.message : String(error) } }
    },
  }
}
