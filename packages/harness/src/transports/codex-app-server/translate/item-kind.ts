import { asText as text } from "@claxedo/agent-runtime-contract"
import type { v2 } from "./protocol"
import { codexSubagentActivity } from "./subagent-items"
import { own } from "../../../translate/value"

const ITEM_KINDS: Record<v2.ThreadItem["type"], readonly [kind: string, toolName?: string]> = {
  userMessage: ["user_message"],
  hookPrompt: ["hook_prompt", "hook_prompt"],
  agentMessage: ["assistant_message"],
  functionCallOutput: ["dynamic_tool_call"],
  plan: ["plan"],
  reasoning: ["reasoning"],
  commandExecution: ["command_execution", "command"],
  fileChange: ["file_change", "apply_patch"],
  mcpToolCall: ["mcp_tool_call"],
  dynamicToolCall: ["dynamic_tool_call"],
  collabAgentToolCall: ["dynamic_tool_call"],
  subAgentActivity: ["subagent_activity"],
  webSearch: ["web_search", "web_search"],
  imageView: ["image_view", "view_image"],
  sleep: ["sleep", "sleep"],
  imageGeneration: ["image_generation", "image_generation"],
  enteredReviewMode: ["review", "review"],
  exitedReviewMode: ["review", "review"],
  contextCompaction: ["context_compaction"],
}

const TOOL_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(ITEM_KINDS).flatMap(([kind, name]) => name ? [[kind, name]] : []))

export function canonicalItemType(raw: unknown) {
  return own(ITEM_KINDS, text(raw) ?? "")?.[0] ?? "dynamic_tool_call"
}

export function toolNameForItem(itemType: string, row: Record<string, unknown>) {
  const activity = codexSubagentActivity(row)
  if (activity) return activity.kind === "started" ? "subagent" : `subagent_${activity.kind}`
  return own(TOOL_NAMES, itemType)
    ?? text(row.tool) ?? text(row.toolName) ?? text(row.name) ?? text(row.title) ?? "tool"
}
