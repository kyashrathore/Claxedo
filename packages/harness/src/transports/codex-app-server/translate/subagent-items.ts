import { asRecord } from "@claxedo/helpers/guards"
import type { SubagentStatus, SubagentToolCallRole } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"

export type CodexCollabAgentCall = {
  id: string
  tool: string
  toolCallRole: SubagentToolCallRole
  senderThreadId: string
  receiverThreadIds: string[]
  prompt?: string
  model?: string
  statuses: Record<string, SubagentStatus>
}

const SUBAGENT_ACTIVITY_KINDS = ["started", "interacted", "interrupted", "completed"] as const

export function codexSubagentActivity(value: unknown) {
  const row = asRecord(value)
  if (row?.type !== "subAgentActivity") return undefined
  const id = text(row.id)
  const agentThreadId = text(row.agentThreadId)
  const kind = SUBAGENT_ACTIVITY_KINDS.find((value) => value === row.kind)
  if (!id || !agentThreadId || !kind) return undefined
  return { id, agentThreadId, kind, agentPath: text(row.agentPath) }
}

export function codexCollabAgentCall(value: unknown): CodexCollabAgentCall | undefined {
  const row = asRecord(value)
  if (row?.type !== "collabAgentToolCall") return undefined
  const id = text(row.id)
  const tool = text(row.tool)
  const senderThreadId = text(row.senderThreadId)
  if (!id || !tool || !senderThreadId || !Array.isArray(row.receiverThreadIds)) return undefined
  const receiverThreadIds = row.receiverThreadIds.filter((value): value is string => typeof value === "string" && value.length > 0)
  const agentsStates = asRecord(row.agentsStates) ?? {}
  return {
    id,
    tool,
    toolCallRole: tool === "spawnAgent" || tool === "spawn_agent" ? "spawn" : "interaction",
    senderThreadId,
    receiverThreadIds,
    ...(text(row.prompt) ? { prompt: text(row.prompt) } : {}),
    ...(text(row.model) ? { model: text(row.model) } : {}),
    statuses: Object.fromEntries(receiverThreadIds.flatMap((threadId) => {
      const status = codexCollabAgentStatus(asRecord(agentsStates[threadId])?.status)
      return status ? [[threadId, status]] : []
    })),
  }
}

export function codexCollabAgentStatus(value: unknown): SubagentStatus | undefined {
  const status = text(value)
  if (status === "pendingInit") return "pending"
  if (status === "running") return "running"
  if (status === "interrupted") return "interrupted"
  if (status === "completed") return "completed"
  if (status === "errored" || status === "notFound") return "failed"
  if (status === "shutdown") return "killed"
  return undefined
}
