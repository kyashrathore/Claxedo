import type { AgentPermission, AgentPermissionReply, AgentQuestion } from "@claxedo/agent-runtime-contract"
import { requestId } from "../ids"
import type { AgentRequest } from "../types"

export function permissionRequest(permission: AgentPermission): AgentRequest {
  return { kind: "permission", id: requestId(permission.id), permission }
}

export function questionRequest(question: AgentQuestion): AgentRequest {
  return { kind: "question", id: requestId(question.id), question }
}

export function isPermissionWire(value: unknown): value is AgentPermission {
  const row = value as { id?: unknown; sessionID?: unknown; permission?: unknown } | null
  return !!row && typeof row.id === "string" && typeof row.sessionID === "string" && typeof row.permission === "string"
}

export function isQuestionWire(value: unknown): value is AgentQuestion {
  const row = value as { id?: unknown; sessionID?: unknown; questions?: unknown } | null
  return !!row && typeof row.id === "string" && typeof row.sessionID === "string" && Array.isArray(row.questions)
}

export function permissionReplyBody(reply: AgentPermissionReply): Record<string, unknown> {
  if (typeof reply === "string") return { response: reply }
  return { optionId: reply.optionId }
}
