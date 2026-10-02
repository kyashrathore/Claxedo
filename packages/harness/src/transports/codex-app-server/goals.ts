import { type AgentGoalMutationResult, type RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import { errorMessage } from "@claxedo/helpers"
import { goalSnapshotFromRecord, type HarnessSession, type NativeGoalOperations, type SessionBroker } from "../../contract"
import { CodexTransportError } from "./errors"
import { codexStopDeadline, type CodexTerminals } from "./terminals"
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

function publishGoal(entry: GoalEntry, goal: RuntimeGoalSnapshot | null): void {
  entry.goal = goal
  void entry.broker.goal.publish(goal).then(undefined, (error: unknown) => entry.broker.reportFailure(error))
}

async function setGoalState(entry: GoalEntry, session: HarnessSession, params: Record<string, unknown>): Promise<AgentGoalMutationResult> {
  const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/set", { threadId: session.binding.upstreamSessionId, ...params }))
  const goal = snapshotFromCodexGoal(session.binding.sessionId, result.goal)
  publishGoal(entry, goal)
  return { ok: true, goal }
}

async function clearGoalState(entry: GoalEntry, session: HarnessSession): Promise<AgentGoalMutationResult<null>> {
  const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/clear", { threadId: session.binding.upstreamSessionId }))
  if (result.cleared !== true) return { ok: false, status: "not_found", message: "No Codex goal exists" }
  publishGoal(entry, null)
  return { ok: true, goal: null }
}

async function interrupt(entry: GoalEntry): Promise<void> {
  const turnId = entry.providerTurn?.id ?? entry.turn?.id
  if (!turnId) return
  const stopped = await entry.terminals.stop(turnId, codexStopDeadline())
  if (stopped.execution !== "terminal") throw new CodexTransportError("process", "Codex turn was not confirmed stopped after the goal transition")
  if (stopped.cleanup === "verified_clear" || !entry.terminals.ranCommand(turnId)) return
  await entry.broker.publish({ type: "harness-notice", code: "codex.background_commands_unverified", severity: "warn",
    message: "Background commands started by the stopped Codex turn may still be running",
    details: { turnId, cleanup: stopped.cleanup, ...(stopped.error ? { error: stopped.error } : {}) } })
}

async function mutate<T extends RuntimeGoalSnapshot | null>(resolve: ResolveGoalEntry, session: HarnessSession,
  change: (entry: GoalEntry) => Promise<AgentGoalMutationResult<T>>, stopsTurn: boolean): Promise<AgentGoalMutationResult<T>> {
  try {
    const entry = await resolve(session)
    const changed = await change(entry)
    if (changed.ok && stopsTurn) await interrupt(entry)
    return changed
  } catch (error) { return { ok: false, status: "failed", message: errorMessage(error) } }
}

async function readCodexGoal(entry: GoalEntry, session: HarnessSession): Promise<RuntimeGoalSnapshot | null> {
  const result = asRecordOrEmpty(await entry.rpc.request("thread/goal/get", { threadId: session.binding.upstreamSessionId }))
  entry.goal = result.goal ? snapshotFromCodexGoal(session.binding.sessionId, result.goal) : null
  return entry.goal
}

export async function reconcileCodexGoal(entry: GoalEntry & { session: HarnessSession }): Promise<void> {
  const goal = await readCodexGoal(entry, entry.session)
  const held = entry.broker.goal.read()
  if (held?.status !== goal?.status || held?.objective !== goal?.objective) publishGoal(entry, goal)
}

export function createCodexGoals(resolve: ResolveGoalEntry): NativeGoalOperations {
  return {
    read: async (session) => readCodexGoal(await resolve(session), session),
    start: (session, objective) => mutate(resolve, session, (entry) => setGoalState(entry, session, { objective }), false),
    pause: (session) => mutate(resolve, session, (entry) => setGoalState(entry, session, { status: "paused" }), true),
    resume: (session) => mutate(resolve, session, (entry) => setGoalState(entry, session, { status: "active" }), false),
    stop: (session) => mutate(resolve, session, (entry) => clearGoalState(entry, session), true),
    delete: (session) => mutate(resolve, session, (entry) => clearGoalState(entry, session), false),
  }
}
