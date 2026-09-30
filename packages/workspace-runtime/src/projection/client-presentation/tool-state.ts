import type { AgentContentPart } from "@claxedo/agent-runtime-contract"

type ToolPart = Extract<AgentContentPart, { type: "tool" }>
type ToolStateStatus = ToolPart["state"]["status"]

function isTextContent(item: unknown): boolean {
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "content") return false
  const inner = (item as { content?: unknown }).content
  return !!inner && typeof inner === "object" && (inner as { type?: unknown }).type === "text"
}

export function withoutOutputText(metadata: Record<string, unknown>): Record<string, unknown> {
  const acp = metadata.acp
  if (!acp || typeof acp !== "object" || !Array.isArray((acp as { content?: unknown }).content)) return metadata
  const { content, ...rest } = acp as { content: unknown[] } & Record<string, unknown>
  const kept = content.filter((item) => !isTextContent(item))
  return { ...metadata, acp: kept.length ? { ...rest, content: kept } : rest }
}

export function toolState(input: {
  status: ToolStateStatus
  tool: string
  stateInput: Record<string, unknown>
  metadata: Record<string, unknown>
  now: number
  output?: string
  error?: string
  attachments: Extract<AgentContentPart, { type: "file" }>[]
}): ToolPart["state"] {
  if (input.status === "pending") {
    return {
      status: "pending",
      input: input.stateInput,
      raw: JSON.stringify(input.stateInput),
    }
  }
  if (input.status === "completed") {
    return {
      status: "completed",
      input: input.stateInput,
      output: input.output ?? "",
      title: input.tool,
      metadata: input.metadata,
      time: { start: input.now, end: input.now },
      ...(input.attachments.length ? { attachments: input.attachments } : {}),
    }
  }
  if (input.status === "error") {
    return {
      status: "error",
      input: input.stateInput,
      error: input.error ?? "tool failed",
      ...(Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
      time: { start: input.now, end: input.now },
    }
  }
  return {
    status: "running",
    input: input.stateInput,
    ...(Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
    time: { start: input.now },
  }
}
