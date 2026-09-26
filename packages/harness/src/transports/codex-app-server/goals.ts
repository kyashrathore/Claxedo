import { type AgentGoalMutationResult, type RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import { errorMessage } from "@claxedo/helpers"
import { goalSnapshotFromRecord, type HarnessSession, type NativeGoalOperations, type SessionBroker } from "../../contract"
import { CodexTransportError } from "./errors"
import type { CodexTerminals } from "./terminals"
import type { CodexRpc } from "./rpc"

type GoalEntry = { rpc: CodexRpc; broker: SessionBroker; goal: RuntimeGoalSnapshot | null; terminals: CodexTerminals;
  providerTurn?: { id: string }; turn?: { id?: string } }

export function snapshotFromCodexGoal(sessionId: string, value: unknown): RuntimeGoalSnapshot {
  return goalSnapshotFromRecord(sessionId, value, {
    invalid: () => new CodexTransportError("protocol", "Codex returned an invalid goal"),
    now: Date.now(),
    status: (status) => status === "usageLimited" || status === "budgetLimited" ? "limited" : status,
  })
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
  } catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
}

async function clearGoalState(resolve: ResolveGoalEntry, session: HarnessSession): Promise<AgentGoalMutationResult<null>> {
  try {
    const entry = resolve(session)
    const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/clear", { threadId: session.binding.upstreamSessionId }))
    if (result.cleared !== true) return { ok: false, status: "not_found", message: "No Codex goal exists" }
    entry.goal = null
    await entry.broker.goal.publish(null)
    return { ok: true, goal: null }
  } catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
}

async function interrupt(resolve: ResolveGoalEntry, session: HarnessSession): Promise<void> {
  const entry = resolve(session)
  const turnId = entry.providerTurn?.id ?? entry.turn?.id
  if (!turnId) return
  const deadline = { at: Date.now() + 10_000, signal: new AbortController().signal }
  const stopped = await entry.terminals.stop(turnId, deadline)
  const confirmed = stopped.execution === "terminal" && stopped.cleanup === "verified_clear"
    ? stopped : await entry.terminals.confirm(turnId, stopped, deadline)
  if (confirmed.execution !== "terminal" || confirmed.cleanup !== "verified_clear") {
    throw new CodexTransportError("process", "Codex turn interruption or background cleanup is unverified")
  }
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
      try { await interrupt(resolve, session) }
      catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
      return setGoalState(resolve, session, { status: "paused" })
    },
    resume: (session) => setGoalState(resolve, session, { status: "active" }),
    stop: async (session) => {
      try { await interrupt(resolve, session) }
      catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
      return clearGoalState(resolve, session)
    },
    delete: (session) => clearGoalState(resolve, session),
  }
}
