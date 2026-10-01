import { asRecord, asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "../../translate/host-subagent"

export function codexHostSubagentObservation(turnThreadId: string, params: unknown): SubagentObservation | undefined {
  const notification = asRecordOrEmpty(params)
  const item = asRecord(notification.item)
  if (item?.type !== "mcpToolCall") return undefined
  const toolCallId = asString(item.id)
  const tool = asString(item.tool)
  if (!toolCallId || !tool || !isHostSubagentTool(tool, asString(item.server))) return undefined
  const binding = hostSubagentBinding(item.result)
  if (!binding) return undefined
  return {
    ...hostSubagentObservation({ observationId: `codex:host-subagent:${turnThreadId}:${toolCallId}`, harnessExecutionId: turnThreadId, toolCallId, binding }),
    ...(notification.threadId === turnThreadId ? { toolCallRole: "spawn" as const } : {}),
  }
}
