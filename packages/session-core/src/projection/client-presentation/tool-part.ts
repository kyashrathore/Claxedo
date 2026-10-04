import type { AgentContentPart, AgentPartRetraction } from "@claxedo/agent-runtime-contract"
import { partEvent, seqId, type CompatContext } from "./context"
import { attachmentPart } from "./file-parts"

type ToolPart = Extract<AgentContentPart, { type: "tool" }>
type ToolStateStatus = ToolPart["state"]["status"]

function toolAttachments(ctx: CompatContext, toolCallId: string) {
  return (ctx.toolAttachmentsByCallId.get(toolCallId) ?? []).map((attachment, index) =>
    attachmentPart(ctx, seqId(ctx, `${toolCallId}-attachment-${index}`, `${ctx.assistantMsgId}-${toolCallId}-attachment-${index}`), attachment))
}

function toolState(input: {
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

function toolPart(input: {
  ctx: CompatContext
  toolCallId: string
  tool: string
  stateInput: Record<string, unknown>
  status: ToolStateStatus
  metadata?: Record<string, unknown>
  now: number
  output?: string
  error?: string
  retracted?: AgentPartRetraction
}): ToolPart {
  return {
    id: seqId(input.ctx, input.toolCallId, `${input.ctx.assistantMsgId}-${input.toolCallId}`),
    sessionID: input.ctx.sessionId,
    messageID: input.ctx.assistantMsgId,
    type: "tool",
    callID: input.toolCallId,
    tool: input.tool,
    state: toolState({
      status: input.status,
      tool: input.tool,
      stateInput: input.stateInput,
      metadata: input.metadata ?? {},
      now: input.now,
      attachments: toolAttachments(input.ctx, input.toolCallId),
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    }),
    ...(input.status === "pending" && input.metadata && Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
    ...(input.retracted ? { retracted: input.retracted } : {}),
  }
}

export function toolEvent(input: Parameters<typeof toolPart>[0]) {
  return partEvent(input.ctx.directory, toolPart(input), input.now)
}
