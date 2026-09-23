import {
  codexCollabAgentCall,
  codexSubagentActivity,
  codexStartedSubagent,
} from "@claxedo/agent-event-runtime/harnesses/codex"
import { asRecord } from "@claxedo/helpers/guards"
import { text, type JsonRecord, type SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import { codexHostSubagentObservation } from "./host-subagent"

const CODEX_SOURCE = "codex.app-server"

/** `thread/started` names the thread it announces instead of carrying a `threadId`. */
function notificationThreadId(params: JsonRecord) {
  return text(params.threadId) ?? text(asRecord(params.thread)?.id)
}

function subagentThreads(method: string, params: JsonRecord) {
  const started = method === "thread/started" ? codexStartedSubagent(params) : undefined
  if (started) return { parentThreadId: started.parentThreadId, threadIds: [started.id] }
  const activity = codexSubagentActivity(params.item)
  const activityThreadId = text(params.threadId)
  if (activity && activityThreadId) return { parentThreadId: activityThreadId, threadIds: [activity.agentThreadId] }
  const call = codexCollabAgentCall(asRecord(params.item))
  if (call) return { parentThreadId: call.senderThreadId, threadIds: call.receiverThreadIds }
  return undefined
}

/**
 * Which running turn answers for a Codex thread. One app-server hands
 * every turn every thread's notifications, and a turn that projected another
 * session's frames would hold them as unresolved child events of its own.
 *
 * `activeThreads` is keyed by the thread of every running turn. A thread with
 * its own running turn is that turn's even when it is also a subagent of
 * another, so its frames are not projected twice.
 */
export function createCodexThreadOwnership(activeThreads: ReadonlyMap<string, unknown>) {
  const subagentsByTurn = new Map<string, Set<string>>()

  const ownedElsewhere = (threadId: string, turnThreadId: string) => {
    if (threadId === turnThreadId) return false
    if (activeThreads.has(threadId)) return true
    if (subagentsByTurn.get(turnThreadId)?.has(threadId)) return false
    for (const [owner, subagents] of subagentsByTurn) {
      if (owner !== turnThreadId && subagents.has(threadId)) return true
    }
    return false
  }

  return {
    track(turnThreadId: string) {
      const subagents = new Set<string>()
      subagentsByTurn.set(turnThreadId, subagents)
      return {
        /** Records the subagents this notification starts beneath the turn, then answers for it. */
        belongsElsewhere(method: string, params: JsonRecord) {
          const spawned = subagentThreads(method, params)
          if (spawned && (spawned.parentThreadId === turnThreadId || subagents.has(spawned.parentThreadId))) {
            for (const threadId of spawned.threadIds) subagents.add(threadId)
          }
          // A started thread is judged by its parent as well: listeners run in
          // registration order, so the turn that owns it may not have recorded it yet.
          return [notificationThreadId(params), spawned?.parentThreadId]
            .some((threadId) => threadId !== undefined && ownedElsewhere(threadId, turnThreadId))
        },
        release() {
          if (subagentsByTurn.get(turnThreadId) === subagents) subagentsByTurn.delete(turnThreadId)
        },
      }
    },
    clear() {
      subagentsByTurn.clear()
    },
  }
}

/**
 * A descendant folded into its first-level ancestor has no session of its
 * own, so the frames that start, end, fail, name or plan one would restate
 * the ancestor's session instead.
 */
const DESCENDANT_SESSION_LIFECYCLE = new Set([
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "thread/status/changed",
  "thread/closed",
  "thread/name/updated",
  "error",
])

/**
 * Projects one turn's app-server notifications: the subagent observations
 * each carries and the routed transcript event.
 *
 * Only the turn thread's direct children are subagents with sessions of
 * their own. A thread started beneath one of them, at any depth, is folded
 * into that first-level child: its frames route under the child's thread id,
 * and its usage keeps its own thread's scope, so it adds to the child's.
 *
 * `parentOwned` is what the caller acts on: a notification naming another
 * thread belongs to a child of this turn, and routing it to the parent would
 * put a subagent's output in the user's transcript.
 */
export function createCodexThreadProjection(input: SdkRuntimeTurnInput, threadId: string) {
  const firstLevelByThread = new Map<string, string>()

  const recordLineage = (method: string, params: JsonRecord) => {
    const spawned = subagentThreads(method, params)
    if (!spawned) return
    const firstLevel = spawned.parentThreadId === threadId ? undefined : firstLevelByThread.get(spawned.parentThreadId)
    if (spawned.parentThreadId !== threadId && !firstLevel) return
    // A thread keeps the ancestor it was first seen under: a later message
    // sent to it by another subagent does not move its transcript.
    for (const spawnedThreadId of spawned.threadIds) {
      if (spawnedThreadId === threadId || firstLevelByThread.has(spawnedThreadId)) continue
      firstLevelByThread.set(spawnedThreadId, firstLevel ?? spawnedThreadId)
    }
  }

  return async (method: string, params: JsonRecord, frame: unknown) => {
    recordLineage(method, params)
    await observeFirstLevelSubagents(input, threadId, method, params, frame)
    const eventThreadId = notificationThreadId(params)
    const raw = { source: CODEX_SOURCE, method, payload: params }
    const source = { dir: "in" as const, method, frame }
    if (!eventThreadId || eventThreadId === threadId) {
      input.ingest(raw, source, { kind: "parent" })
      return { parentOwned: true, eventThreadId }
    }
    const firstLevel = firstLevelByThread.get(eventThreadId) ?? eventThreadId
    if (firstLevel === eventThreadId || !DESCENDANT_SESSION_LIFECYCLE.has(method)) {
      input.ingest(raw, source, { kind: "child", correlationKey: firstLevel })
    }
    return { parentOwned: false, eventThreadId }
  }
}

export type CodexThreadProjection = ReturnType<typeof createCodexThreadProjection>

async function observeFirstLevelSubagents(
  input: SdkRuntimeTurnInput,
  threadId: string,
  method: string,
  params: JsonRecord,
  frame: unknown,
) {
  const activity = codexSubagentActivity(params.item)
  if (activity && params.threadId === threadId) {
    await input.observeSubagent({
      observation: {
        observationId: `codex:activity:${activity.id}:${activity.kind}`,
        harnessExecutionId: threadId,
        stableCorrelationId: activity.agentThreadId,
        providerId: activity.agentThreadId,
        providerKind: "codex",
        status: activity.kind === "started" ? "running" : "completed",
        transcript: { kind: "live" },
        ...(activity.kind === "started" ? { toolCallId: activity.id, toolCallRole: "spawn" as const } : {}),
        ...(activity.agentPath ? { label: activity.agentPath } : {}),
      },
      correlationKeys: [activity.agentThreadId],
      source: { dir: "in", method, frame },
    })
  }
  const startedSubagent = method === "thread/started" ? codexStartedSubagent(params) : undefined
  if (startedSubagent?.parentThreadId === threadId) {
    await input.observeSubagent({
      observation: {
        observationId: `codex:thread-started:${startedSubagent.id}:${startedSubagent.status}`,
        harnessExecutionId: threadId,
        stableCorrelationId: startedSubagent.id,
        providerId: startedSubagent.id,
        providerKind: "codex",
        status: startedSubagent.status,
        transcript: { kind: "live" },
        ...(startedSubagent.label ? { label: startedSubagent.label } : {}),
        ...(startedSubagent.subagentType ? { subagentType: startedSubagent.subagentType } : {}),
        ...(startedSubagent.description ? { description: startedSubagent.description } : {}),
      },
      correlationKeys: [startedSubagent.id],
      source: { dir: "in", method, frame },
    })
  }
  const call = codexCollabAgentCall(asRecord(params.item))
  if (call?.senderThreadId === threadId) {
    await Promise.all(call.receiverThreadIds.map((receiverThreadId) => input.observeSubagent({
      observation: {
        observationId: `codex:${method}:${call.id}:${receiverThreadId}:${call.statuses[receiverThreadId] ?? "edge"}`,
        harnessExecutionId: threadId,
        stableCorrelationId: receiverThreadId,
        toolCallId: call.id,
        toolCallRole: call.toolCallRole,
        providerId: receiverThreadId,
        providerKind: "codex",
        transcript: { kind: "live" },
        ...(call.statuses[receiverThreadId]
          ? { status: call.statuses[receiverThreadId] }
          : call.toolCallRole === "spawn" && method === "item/started"
            ? { status: "pending" as const }
            : {}),
        ...(call.prompt ? { description: call.prompt } : {}),
        subagentType: call.model ?? "codex",
      },
      correlationKeys: [receiverThreadId],
      source: { dir: "in", method, frame },
    })))
  }
  const hostSpawn = method === "item/completed" ? codexHostSubagentObservation(threadId, asRecord(params.item)) : undefined
  if (hostSpawn) await input.observeSubagent({ observation: hostSpawn, correlationKeys: [], source: { dir: "in", method, frame } })
}
