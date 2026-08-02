import type { ToolDisplay, ToolIntent } from "../contracts/agent-runtime-event"
import { text } from "./value"

export function canonicalToolIntent(input: { kind?: string; toolName?: string }): ToolIntent {
  const kind = input.kind?.toLowerCase()
  const tool = input.toolName?.toLowerCase() ?? ""
  if (kind === "command_execution" || kind === "execute" || tool === "bash" || tool.includes("shell") || tool.includes("command")) return "shell"
  if (kind === "file_change" || kind === "edit" || kind === "write" || tool.includes("edit") || tool.includes("write") || tool.includes("patch")) return "edit"
  if (kind === "file_read" || kind === "read") {
    if (tool.includes("grep") || tool.includes("glob")) return "search"
    return "read"
  }
  if (kind === "web_search") return "search"
  if (kind === "mcp_tool_call" || tool.startsWith("mcp__") || tool === "mcp") return "mcp"
  if (kind === "collab_agent_tool_call" || tool === "task" || tool === "agent") return "task"
  if (kind === "fetch") return "fetch"
  if (kind === "move") return "move"
  if (kind === "delete") return "delete"
  return "generic"
}

export function toolDisplayFromInput(input: {
  kind: string
  toolName?: string
  input?: Record<string, unknown>
}) {
  return {
    kind: input.kind,
    intent: canonicalToolIntent(input),
    ...(text(input.input?.command) ? { command: text(input.input?.command), description: text(input.input?.command) } : {}),
    ...(text(input.input?.filePath) ? { filePath: text(input.input?.filePath) } : {}),
    ...(text(input.input?.file_path) ? { filePath: text(input.input?.file_path) } : {}),
    ...(text(input.input?.path) ? { path: text(input.input?.path) } : {}),
    ...(text(input.input?.pattern) ? { pattern: text(input.input?.pattern) } : {}),
    ...(text(input.input?.query) ? { query: text(input.input?.query) } : {}),
    ...(text(input.input?.url) ? { url: text(input.input?.url) } : {}),
    ...(text(input.input?.prompt) ? { description: text(input.input?.prompt) } : {}),
    ...(text(input.input?.description) ? { description: text(input.input?.description) } : {}),
    ...(text(input.input?.subagent_type) ? { subagentType: text(input.input?.subagent_type) } : {}),
    ...(input.input ? { input: input.input } : {}),
  } satisfies ToolDisplay
}
