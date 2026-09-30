import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { isHostSubagentTool } from "../../../translate/host-subagent"
import { assistantToolBlocks } from "./assistant-content"
import type { ClaudeTaskLedger } from "./task-ledger"
import { isTaskTool } from "./tool-blocks"

export function claudeChildCorrelationKey(value: unknown) {
  return text(asRecord(value)?.parent_tool_use_id)
}

export function claudeStreamOwner(message: Record<string, unknown>) {
  return claudeChildCorrelationKey(message) ?? ""
}

export function foldNestedSubagentFrame(frame: unknown, ledger: ClaudeTaskLedger): unknown {
  const message = asRecord(frame)
  const owner = claudeChildCorrelationKey(message)
  if (!message || !owner) return frame
  const firstLevel = ledger.firstLevelSubagent(owner)
  if (message.type === "assistant") {
    for (const { tool } of assistantToolBlocks(message)) {
      if (isTaskTool(tool.toolName) && !isHostSubagentTool(tool.toolName)) ledger.nestSubagentCall(tool.toolCallId, firstLevel)
    }
  }
  return firstLevel === owner ? frame : { ...message, parent_tool_use_id: firstLevel }
}
