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

type ResolveGoalEntry = (session: HarnessSession) => Promise<GoalEntry>

async function setGoalState(resolve: ResolveGoalEntry, session: HarnessSession, params: Record<string, unknown>): Promise<AgentGoalMutationResult> {
  try {
    const entry = await resolve(session)
    const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/set", { threadId: session.binding.upstreamSessionId, ...params }))
    const goal = snapshotFromCodexGoal(session.binding.sessionId, result.goal)
    entry.goal = goal
    await entry.broker.goal.publish(goal)
    return { ok: true, goal }
  } catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
}

async function clearGoalState(resolve: ResolveGoalEntry, session: HarnessSession): Promise<AgentGoalMutationResult<null>> {
  try {
    const entry = await resolve(session)
    const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/clear", { threadId: session.binding.upstreamSessionId }))
    if (result.cleared !== true) return { ok: false, status: "not_found", message: "No Codex goal exists" }
    entry.goal = null
    await entry.broker.goal.publish(null)
    return { ok: true, goal: null }
  } catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
}

async function interrupt(resolve: ResolveGoalEntry, session: HarnessSession): Promise<void> {
  const entry = await resolve(session)
  const turnId = entry.providerTurn?.id ?? entry.turn?.id
  if (!turnId) return
  const stopped = await entry.terminals.stop(turnId, { at: Date.now() + 10_000, signal: new AbortController().signal })
  if (stopped.execution !== "terminal") throw new CodexTransportError("process", "Codex turn was not confirmed stopped before the goal transition")
  if (stopped.cleanup === "verified_clear" || !entry.terminals.ranCommand(turnId)) return
  await entry.broker.publish({ type: "harness-notice", code: "codex.background_commands_unverified", severity: "warn",
    message: "Background commands started by the stopped Codex turn may still be running",
    details: { turnId, cleanup: stopped.cleanup, ...(stopped.error ? { error: stopped.error } : {}) } })
}

async function readCodexGoal(entry: GoalEntry, session: HarnessSession): Promise<RuntimeGoalSnapshot | null> {
  const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/get", { threadId: session.binding.upstreamSessionId }))
  entry.goal = result.goal ? snapshotFromCodexGoal(session.binding.sessionId, result.goal) : null
  return entry.goal
}

export async function reconcileCodexGoal(entry: GoalEntry & { session: HarnessSession }): Promise<void> {
  const goal = await readCodexGoal(entry, entry.session)
  const held = entry.broker.goal.read()
  if (held?.status !== goal?.status || held?.objective !== goal?.objective) await entry.broker.goal.publish(goal)
}

export function createCodexGoals(resolve: ResolveGoalEntry): NativeGoalOperations {
  return {
    read: async (session) => readCodexGoal(await resolve(session), session),
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
