import type { AgentPermission, AgentPermissionReply, AgentQuestion } from "@claxedo/agent-runtime-contract"
import { requestId } from "../ids"
import type { AgentRequest } from "../types"
import { isRecord } from "@claxedo/helpers/guards"

export function requestFromPermission(permission: AgentPermission): AgentRequest {
  return { kind: "permission", id: requestId(permission.id), permission }
}

export function requestFromQuestion(question: AgentQuestion): AgentRequest {
  return { kind: "question", id: requestId(question.id), question }
}

export function isPermissionWire(value: unknown): value is AgentPermission {
  return isRecord(value) && typeof value.id === "string" && typeof value.sessionID === "string" && typeof value.permission === "string"
}

export function isQuestionWire(value: unknown): value is AgentQuestion {
  return isRecord(value) && typeof value.id === "string" && typeof value.sessionID === "string" && Array.isArray(value.questions)
}

export function permissionReplyBody(reply: AgentPermissionReply): Record<string, unknown> {
  if (typeof reply === "string") return { response: reply }
  return { optionId: reply.optionId }
}
