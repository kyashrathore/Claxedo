import { mcpToolVisibleTo } from "@claxedo/agent-runtime-contract"
import { asRecord, isNonEmptyString } from "@claxedo/helpers/guards"
import { contractMismatch } from "../errors"
import type { McpAppTool, McpProtocolResult } from "../mcp-app-types"

function toolFromWire(value: unknown): McpAppTool | undefined {
  const tool = asRecord(value)
  if (!tool || !isNonEmptyString(tool.name)) return undefined
  return {
    name: tool.name,
    readOnly: asRecord(tool.annotations)?.readOnlyHint === true,
    visibleToApp: mcpToolVisibleTo(tool._meta, "app"),
  }
}

export function mcpAppToolsFromWire(body: unknown): readonly McpAppTool[] {
  const tools = asRecord(body)?.tools
  if (!Array.isArray(tools)) throw contractMismatch("MCP tool list")
  return tools.flatMap((tool) => toolFromWire(tool) ?? [])
}

export function mcpToolCallFromWire(body: unknown): McpProtocolResult {
  const result = asRecord(body)
  if (!result || !Array.isArray(result.content)) throw contractMismatch("MCP tool call")
  return result
}

export function mcpResourceReadFromWire(body: unknown): McpProtocolResult {
  const result = asRecord(body)
  if (!result || !Array.isArray(result.contents)) throw contractMismatch("MCP resource read")
  return result
}
