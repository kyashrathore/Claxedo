import { asText as text } from "@claxedo/agent-runtime-contract"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import type { v2 } from "./protocol"
import { codexSubagentActivity } from "./subagent-items"

const ITEM_KINDS: Record<v2.ThreadItem["type"], string> = {
  userMessage: "user_message",
  hookPrompt: "hook_prompt",
  agentMessage: "assistant_message",
  functionCallOutput: "dynamic_tool_call",
  plan: "plan",
  reasoning: "reasoning",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  dynamicToolCall: "dynamic_tool_call",
  collabAgentToolCall: "dynamic_tool_call",
  subAgentActivity: "subagent_activity",
  webSearch: "web_search",
  imageView: "image_view",
  sleep: "sleep",
  imageGeneration: "image_generation",
  enteredReviewMode: "review",
  exitedReviewMode: "review",
  contextCompaction: "context_compaction",
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  command_execution: "command",
  file_change: "apply_patch",
  web_search: "web_search",
  image_view: "view_image",
  image_generation: "image_generation",
  sleep: "sleep",
  hook_prompt: "hook_prompt",
  review: "review",
}

export function canonicalItemType(raw: unknown) {
  const type = text(raw)
  return type && Object.hasOwn(ITEM_KINDS, type) ? ITEM_KINDS[type as v2.ThreadItem["type"]] : "dynamic_tool_call"
}

export function toolNameForItem(itemType: string, row: Record<string, unknown>) {
  const activity = codexSubagentActivity(row)
  if (activity) return activity.kind === "started" ? "subagent" : `subagent_${activity.kind}`
  if (Object.hasOwn(TOOL_NAMES, itemType)) return TOOL_NAMES[itemType]!
  return text(row.tool) ?? text(row.toolName) ?? text(row.name) ?? text(row.title) ?? "tool"
}

export function toolDisplay(itemType: string, input: Record<string, unknown> | undefined, toolName?: string) {
  return toolDisplayFromInput({
    kind: itemType,
    ...(toolName ? { toolName } : {}),
    ...(input ? { input } : {}),
  })
}
