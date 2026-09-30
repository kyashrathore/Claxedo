import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { codexSubagentActivity } from "./subagent-items"

function normalizeItemType(raw: unknown) {
  const value = text(raw)
  if (!value) return "item"
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export function canonicalItemType(raw: unknown) {
  const type = normalizeItemType(raw)
  if (type.includes("user message") || type === "user") return "user_message"
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message"
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning"
  if (type.includes("plan") || type.includes("todo")) return "plan"
  if (type.includes("command")) return "command_execution"
  if (type.includes("file change") || type.includes("patch") || type.includes("edit")) return "file_change"
  if (type.includes("mcp")) return "mcp_tool_call"
  if (type.includes("web search")) return "web_search"
  if (type.includes("image")) return "image_view"
  if (type.includes("error")) return "error"
  return "dynamic_tool_call"
}

export function toolNameForItem(itemType: string, row: Record<string, unknown>) {
  if (codexSubagentActivity(row)) return "subagent"
  return text(row.tool) ?? text(row.toolName) ?? text(row.name) ?? text(row.title) ?? (
    itemType === "command_execution"
      ? "command"
      : itemType === "file_change"
        ? "file-change"
        : itemType === "web_search"
          ? "web-search"
          : row.type === "imageView"
            ? "view_image"
            : "tool"
  )
}

export function structuredInput(row: Record<string, unknown>) {
  if (row.type === "mcpToolCall") {
    return Object.fromEntries(
      ["server", "tool", "arguments", "pluginId"].flatMap((key) => row[key] === undefined ? [] : [[key, row[key]]]),
    )
  }
  const direct = asRecord(row.input)
  if (direct) return direct
  const input = Object.fromEntries(
    ["command", "cwd", "path", "filePath", "query", "prompt", "toolName", "name", "processId", "processHandle", "stream"].flatMap((key) =>
      row[key] === undefined ? [] : [[key, row[key]]],
    ),
  )
  return Object.keys(input).length ? input : undefined
}

export function toolDisplay(itemType: string, input: Record<string, unknown> | undefined, toolName?: string) {
  return toolDisplayFromInput({
    kind: itemType,
    ...(toolName ? { toolName } : {}),
    ...(input ? { input } : {}),
  })
}
