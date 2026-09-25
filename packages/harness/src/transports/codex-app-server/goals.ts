import { isRuntimeGoalStatus, type AgentGoalMutationResult, type RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import type { HarnessSession, NativeGoalOperations, SessionBroker } from "../../contract"
import { CodexTransportError } from "./errors"
import type { CodexRpc } from "./rpc"

type GoalEntry = { rpc: CodexRpc; broker: SessionBroker; goal: RuntimeGoalSnapshot | null; providerTurn?: { id: string }; turn?: { id?: string } }

export function snapshotFromCodexGoal(sessionId: string, value: unknown): RuntimeGoalSnapshot {
  const goal = asRecordOrEmpty(value)
  const objective = goal.objective
  const rawStatus = goal.status
  const status = rawStatus === "usageLimited" || rawStatus === "budgetLimited" ? "limited" : rawStatus
  if (typeof objective !== "string" || !isRuntimeGoalStatus(status)) {
    throw new CodexTransportError("protocol", "Codex returned an invalid goal")
  }
  return { sessionId, objective, status,
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : Date.now(),
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : Date.now(),
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {}),
    ...(typeof goal.tokensUsed === "number" ? { tokensUsed: goal.tokensUsed } : {}),
    ...(typeof goal.timeUsedSeconds === "number" ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
  }
}

type ResolveGoalEntry = (session: HarnessSession) => GoalEntry

async function setGoalState(resolve: ResolveGoalEntry, session: HarnessSession, params: Record<string, unknown>): Promise<AgentGoalMutationResult> {
  try {
    const entry = resolve(session)
    const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/set", { threadId: session.binding.upstreamSessionId, ...params }))
    const goal = snapshotFromCodexGoal(session.binding.sessionId, result.goal)
    entry.goal = goal
    await entry.broker.goal.publish(goal)
    return { ok: true, goal }
  } catch (error) { return { ok: false, status: "failed", message: String(error) } }
}

async function clearGoalState(resolve: ResolveGoalEntry, session: HarnessSession): Promise<AgentGoalMutationResult<null>> {
  try {
    const entry = resolve(session)
    const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/clear", { threadId: session.binding.upstreamSessionId }))
    if (result.cleared !== true) return { ok: false, status: "not_found", message: "No Codex goal exists" }
    entry.goal = null
    await entry.broker.goal.publish(null)
    return { ok: true, goal: null }
  } catch (error) { return { ok: false, status: "failed", message: String(error) } }
}

async function interrupt(resolve: ResolveGoalEntry, session: HarnessSession): Promise<void> {
  const entry = resolve(session)
  const turnId = entry.providerTurn?.id ?? entry.turn?.id
  if (turnId) await entry.rpc.request("turn/interrupt", { threadId: session.binding.upstreamSessionId, turnId })
}

export function createCodexGoals(resolve: ResolveGoalEntry): NativeGoalOperations {
  return {
    async read(session) {
      const entry = resolve(session)
      const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/get", { threadId: session.binding.upstreamSessionId }))
      const goal = result.goal ? snapshotFromCodexGoal(session.binding.sessionId, result.goal) : null
      entry.goal = goal
      return goal
    },
    start: (session, objective) => setGoalState(resolve, session, { objective }),
    pause: async (session) => {
      const result = await setGoalState(resolve, session, { status: "paused" })
      if (result.ok) await interrupt(resolve, session)
      return result
    },
    resume: (session) => setGoalState(resolve, session, { status: "active" }),
    stop: async (session) => {
      const result = await clearGoalState(resolve, session)
      if (result.ok) await interrupt(resolve, session)
      return result
    },
    delete: (session) => clearGoalState(resolve, session),
  }
}
