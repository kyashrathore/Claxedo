import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "@claxedo/agent-event-runtime"
import type { SubagentObservation } from "../../subagent-admission"
import { asRecord } from "@claxedo/helpers/guards"
import { text } from "../shared/sdk-runtime-values"

/**
 * The observation an `item/completed` notification of a `create_subagent` MCP
 * item raises on the turn thread `threadId`. The call is the child's spawn
 * edge only when the turn's own thread made it; a child thread's call is in
 * the child's transcript, so it binds the host-minted row without an edge.
 * Any other item, or one whose result carries no binding, raises none.
 */
export function codexHostSubagentObservation(
  threadId: string,
  params: Record<string, unknown>,
): SubagentObservation | undefined {
  const item = asRecord(params.item)
  if (item?.type !== "mcpToolCall") return undefined
  const toolCallId = text(item.id)
  const tool = text(item.tool)
  if (!toolCallId || !tool || !isHostSubagentTool(tool, text(item.server))) return undefined
  const binding = hostSubagentBinding(item.result)
  if (!binding) return undefined
  return {
    ...hostSubagentObservation({
      observationId: `codex:host-subagent:${threadId}:${toolCallId}`,
      harnessExecutionId: threadId,
      toolCallId,
      binding,
    }),
    ...(params.threadId === threadId ? { toolCallRole: "spawn" as const } : {}),
  }
}
