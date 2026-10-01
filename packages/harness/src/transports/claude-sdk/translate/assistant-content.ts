import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { toolInput } from "./tool-blocks"

const toolUseTypes: readonly string[] = ["tool_use", "server_tool_use", "mcp_tool_use"]

export function assistantBlocks(message: Record<string, unknown>) {
  const row = asRecord(message.message) ?? {}
  const content: unknown[] = Array.isArray(row.content) ? row.content : []
  return content.flatMap((item) => {
    const block = asRecord(item)
    return block ? [block] : []
  })
}

export function assistantSnapshotText(message: Record<string, unknown>, kind: "text" | "thinking" = "text") {
  return assistantBlocks(message).flatMap((block) => block.type === kind ? text(block[kind]) ?? [] : []).join("")
}

export function assistantToolBlocks(message: Record<string, unknown>) {
  return assistantBlocks(message).flatMap((block) => {
    if (!toolUseTypes.includes(String(block.type))) return []
    const toolCallId = text(block.id)
    const toolName = text(block.name)
    if (!toolCallId || !toolName) return []
    return [{
      block,
      tool: {
        type: "tool" as const,
        toolCallId,
        toolName,
        input: toolInput(block.input),
      },
    }]
  })
}
