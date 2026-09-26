import { CODEX_DESCENDANT_ERROR_METHOD } from "@claxedo/harness/codex-app-server/translate"
import {
  codexCollabAgentCall,
  codexSubagentActivity,
  codexStartedSubagent,
} from "@claxedo/harness/codex-app-server/translate"
import { asRecord } from "@claxedo/helpers/guards"
import type { JsonRecord, SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import { codexHostSubagentObservation } from "./host-subagent"
import { codexNotificationThreadId, type CodexThreadRegistry, type CodexTurnClaim } from "./thread-registry"

const CODEX_SOURCE = "codex.app-server"

/**
 * A descendant folded into its first-level ancestor has no session of its
 * own, so the frames that start, end, name or plan one would restate the
 * ancestor's session instead.
 */
const DESCENDANT_SESSION_LIFECYCLE = new Set([
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "thread/status/changed",
  "thread/closed",
  "thread/name/updated",
])

/**
 * Projects the app-server notifications of one running turn: the subagent
 * observations each carries and the routed transcript event.
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
export function createCodexThreadProjection(
  input: SdkRuntimeTurnInput,
  claim: CodexTurnClaim,
  threads: Pick<CodexThreadRegistry, "ownerOf" | "firstLevel">,
) {
  const threadId = claim.threadId
  return {
    /**
     * Whether this turn answers for a notification, decided as it arrives: a
     * frame naming no thread reaches every turn, and one naming a thread is
     * projected only by the turn the registry says owns that thread.
     */
    owns(params: JsonRecord) {
      const eventThreadId = codexNotificationThreadId(params)
      return !eventThreadId || threads.ownerOf(eventThreadId) === claim
    },

    async project(method: string, params: JsonRecord, frame: unknown) {
      await observeFirstLevelSubagents(input, threadId, method, params, frame)
      const eventThreadId = codexNotificationThreadId(params)
      const raw = { source: CODEX_SOURCE, method, payload: params }
      const source = { dir: "in" as const, method, frame }
      if (!eventThreadId || eventThreadId === threadId) {
        input.ingest(raw, source, { kind: "parent" })
        return { parentOwned: true, eventThreadId }
      }
      const firstLevel = threads.firstLevel(eventThreadId) ?? eventThreadId
      const route = { kind: "child" as const, correlationKey: firstLevel }
      if (firstLevel === eventThreadId) input.ingest(raw, source, route)
      else if (method === "error") input.ingest({ ...raw, method: CODEX_DESCENDANT_ERROR_METHOD }, source, route)
      else if (!DESCENDANT_SESSION_LIFECYCLE.has(method)) input.ingest(raw, source, route)
      return { parentOwned: false, eventThreadId }
    },
  }
}

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
