import { isSubagentSpawnToolName, asText as text, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecordOrEmpty as toolInput } from "@claxedo/helpers/guards"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { isHostSubagentTool } from "../../../translate/host-subagent"
import type { ClaudeBlockState } from "./adapter-state"

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

export function toolPresentation(toolName: string, input: Record<string, unknown>) {
  return { display: toolDisplay(toolName, input), metadata: { claude: { itemType: toolKind(toolName) } } }
}

export function toolStartEvents(block: Record<string, unknown>): AgentRuntimeEvent[] {
  const toolCallId = text(block.id)
  const toolName = text(block.name)
  if (!toolCallId || !toolName) return []
  const input = toolInput(block.input)
  const tool = { type: "tool" as const, toolCallId, toolName }
  return [
    {
      type: "tool-start",
      toolCallId,
      toolName,
      kind: toolKind(toolName),
      ...toolPresentation(toolName, input),
    },
    ...(Object.keys(input).length ? toolInputEvents(tool, input) : []),
  ]
}

export function toolInputEvents(tool: ClaudeBlockState, parsedInput: Record<string, unknown>) {
  if (!tool.toolCallId || !tool.toolName) return []
  return [{
    type: "tool-input",
    toolCallId: tool.toolCallId,
    input: parsedInput,
    ...toolPresentation(tool.toolName, parsedInput),
  }] satisfies AgentRuntimeEvent[]
}
