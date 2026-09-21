import {
  codexCollabAgentCall,
  codexSubagentActivity,
  codexStartedSubagent,
} from "@claxedo/agent-event-runtime/harnesses/codex"
import { asRecord } from "@claxedo/helpers/guards"
import { text, type JsonRecord, type SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import { codexHostSubagentObservation } from "./host-subagent"

const CODEX_SOURCE = "codex.app-server"

/**
 * Turns one app-server notification into the subagent observations and the
 * routed transcript event it carries.
 *
 * `parentOwned` is what the caller acts on: a notification naming another
 * thread belongs to a child of this turn, and routing it to the parent would
 * put a subagent's output in the user's transcript.
 */
export async function projectCodexThreadNotification(
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
  const eventThreadId = text(params.threadId) ?? text(asRecord(params.thread)?.id)
  const parentOwned = !eventThreadId || eventThreadId === threadId
  input.ingest({ source: CODEX_SOURCE, method, payload: params }, {
    dir: "in",
    method,
    frame,
  }, parentOwned ? { kind: "parent" } : { kind: "child", correlationKey: eventThreadId })
  return { parentOwned, eventThreadId }
}

