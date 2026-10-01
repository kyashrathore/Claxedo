import { isSubagentSpawnToolName, asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { isHostSubagentTool } from "../../../translate/host-subagent"
import type { ClaudeBlockState } from "./adapter-state"

export function toolInput(value: unknown) {
  return asRecord(value) ?? {}
}

export function isTaskTool(toolName: string) {
  return isSubagentSpawnToolName(toolName) || isHostSubagentTool(toolName)
}

export function toolKind(toolName: string) {
  const normalized = toolName.toLowerCase()
  if (isTaskTool(toolName)) return "collab_agent_tool_call"
  if (normalized === "bash" || normalized.includes("shell") || normalized.includes("command")) return "command_execution"
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) return "file_change"
  if (normalized.includes("read") || normalized.includes("grep") || normalized.includes("glob")) return "file_read"
  return "dynamic_tool_call"
}

export function toolDisplay(toolName: string, input: Record<string, unknown>) {
  return toolDisplayFromInput({
    kind: toolKind(toolName),
    toolName,
    ...(Object.keys(input).length ? { input } : {}),
  })
}

export function toolStartEvents(block: Record<string, unknown>): AgentRuntimeEvent[] {
  const toolCallId = text(block.id)
  const toolName = text(block.name)
  if (!toolCallId || !toolName) return []
  const input = toolInput(block.input)
  const metadata = { claude: { itemType: toolKind(toolName) } }
  const display = toolDisplay(toolName, input)
  return [
    {
      type: "tool-start",
      toolCallId,
      toolName,
      kind: toolKind(toolName),
      display,
      metadata,
    },
    ...(Object.keys(input).length > 0
      ? [{ type: "tool-input", toolCallId, input, display, metadata } satisfies AgentRuntimeEvent]
      : []),
  ]
}

export function toolInputEvents(tool: ClaudeBlockState, parsedInput: Record<string, unknown>) {
  if (!tool.toolCallId || !tool.toolName) return []
  return [{
    type: "tool-input",
    toolCallId: tool.toolCallId,
    input: parsedInput,
    display: toolDisplay(tool.toolName, parsedInput),
    metadata: { claude: { itemType: toolKind(tool.toolName) } },
  }] satisfies AgentRuntimeEvent[]
}
