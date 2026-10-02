import { asText as text } from "@claxedo/agent-runtime-contract"
import { asArray, asRecord, asRecordOrEmpty as toolInput, isRecord } from "@claxedo/helpers/guards"

const toolUseTypes: readonly string[] = ["tool_use", "server_tool_use", "mcp_tool_use"]

export function messageBlocks(message: Record<string, unknown>) {
  const row = asRecord(message.message) ?? {}
  return asArray(row.content).filter(isRecord)
}

export function assistantSnapshotText(message: Record<string, unknown>, kind: "text" | "thinking" = "text") {
  return messageBlocks(message).flatMap((block) => block.type === kind ? text(block[kind]) ?? [] : []).join("")
}

export function assistantToolBlocks(message: Record<string, unknown>) {
  return messageBlocks(message).flatMap((block) => {
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
