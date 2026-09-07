import { hostSubagentBinding, hostSubagentObservation, isHostSubagentTool } from "@claxedo/agent-event-runtime"
import type { SubagentObservation } from "../../subagent-admission"
import { text } from "../shared/sdk-runtime-values"

/**
 * The observation a completed `create_subagent` MCP item raises on the
 * parent. Any other item, or one whose result carries no binding, raises none.
 */
export function codexHostSubagentObservation(
  threadId: string,
  item: Record<string, unknown> | undefined,
): SubagentObservation | undefined {
  if (item?.type !== "mcpToolCall") return undefined
  const toolCallId = text(item.id)
  const tool = text(item.tool)
  if (!toolCallId || !tool || !isHostSubagentTool(tool, text(item.server))) return undefined
  const binding = hostSubagentBinding(item.result)
  if (!binding) return undefined
  return hostSubagentObservation({
    observationId: `codex:host-subagent:${threadId}:${toolCallId}`,
    harnessExecutionId: threadId,
    toolCallId,
    binding,
  })
}
