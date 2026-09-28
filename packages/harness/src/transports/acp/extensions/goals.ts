import type { RuntimeGoalSnapshot, AgentGoalMutationResult } from "@claxedo/agent-runtime-contract"
import { goalSnapshotFromRecord } from "../../../contract/goals"
import type { AcpEntry } from "../index"
import { AcpTransportError } from "../errors"
import { applyAcpGoal } from "../provider-turn"
import { errorMessage } from "@claxedo/helpers"

export function goalSnapshot(sessionId: string, response: Record<string, unknown>): RuntimeGoalSnapshot | null {
  if (response.goal === null) return null
  const goal = response.goal
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) throw new AcpTransportError("protocol", "ACP Goal response is invalid")
  return goalSnapshotFromRecord(sessionId, goal, {
    invalid: () => new AcpTransportError("protocol", "ACP Goal response is invalid"),
  })
}

export function acpGoalOperations(entry: (session: AcpEntry["session"]) => AcpEntry) {
  const request = async (session: AcpEntry["session"], method: string, extra: Record<string, unknown> = {}) => {
    const current = entry(session)
    const goal = goalSnapshot(session.binding.sessionId, await current.peer.agent.extMethod(method,
      { sessionId: session.binding.upstreamSessionId, ...extra }))
    await applyAcpGoal(current, goal)
    return goal
  }
  const mutate = async (session: AcpEntry["session"], method: string, extra: Record<string, unknown> = {}): Promise<AgentGoalMutationResult> => {
    try {
      const goal = await request(session, method, extra)
      if (goal === null) throw new AcpTransportError("protocol", "ACP Goal mutation returned no Goal")
      return { ok: true, goal }
    }
    catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
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
      } catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
    },
  }
}
