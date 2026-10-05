import { productToolKind, type AgentRequest, type AgentRequestReply, type ProductEvent } from "@/server"

export function permissionDecided(request: AgentRequest | undefined, answer: AgentRequestReply): ProductEvent | undefined {
  if (request?.kind !== "permission" || answer.kind !== "permission") return undefined
  const reply = answer.reply
  const decision = typeof reply === "object" ? "option" : reply === "reject" ? "deny" : "allow"
  return { event: "permission_decided", properties: { decision, tool_kind: productToolKind(request.permission.permission) } }
}
