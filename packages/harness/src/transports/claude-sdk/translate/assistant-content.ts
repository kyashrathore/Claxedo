import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { toolInput } from "./tool-blocks"

function assistantContent(message: Record<string, unknown>) {
  const row = asRecord(message.message) ?? {}
  return Array.isArray(row.content) ? row.content : []
}

export function assistantSnapshotText(message: Record<string, unknown>) {
  return assistantContent(message).flatMap((item) => {
    const block = asRecord(item)
    if (!block || block.type !== "text") return []
    return text(block.text) ?? []
  }).join("")
}

export function assistantToolBlocks(message: Record<string, unknown>) {
  return assistantContent(message).flatMap((item) => {
    const block = asRecord(item)
    if (!block || block.type !== "tool_use") return []
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
