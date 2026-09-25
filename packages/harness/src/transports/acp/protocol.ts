import { randomUUID } from "node:crypto"
import type {
  ContentBlock, CreateElicitationRequest, CreateElicitationResponse, ElicitationContentValue, McpServer,
  RequestPermissionRequest, RequestPermissionResponse,
} from "@agentclientprotocol/sdk"
import type { McpServerSpec, RequestAnswer, SessionBroker, TurnBroker, TurnInput } from "../../contract"
import type { PermissionDecision } from "@claxedo/agent-runtime-contract"
import { AcpTransportError } from "./errors"

const protocolPermissionMapping: Record<PermissionDecision, string> = {
  allow_once: "allow_once", allow_always: "allow_always", deny: "reject_once", reject_always: "reject_always",
}

export function acpMcp(server: McpServerSpec): McpServer {
  if (server.kind === "stdio") return { name: server.name, command: server.command,
    args: [...server.args ?? []], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) }
  return { type: server.kind, name: server.name, url: server.url,
    headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
}

export function acpPrompt(turn: TurnInput): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const text = [turn.system, ...turn.prompt.parts.flatMap((part) => part.type === "text" ? [part.text] : [])].filter(Boolean).join("\n\n")
  if (text) blocks.push({ type: "text", text })
  for (const part of turn.prompt.parts) {
    if (part.type !== "file") continue
    const match = part.url.match(/^data:(image\/[^;]+);base64,(.+)$/s)
    if (match?.[1] && match[2]) blocks.push({ type: "image", mimeType: match[1], data: match[2] })
  }
  return blocks
}

export async function acpPermission(request: RequestPermissionRequest, broker: TurnBroker | SessionBroker, sessionId: string): Promise<RequestPermissionResponse> {
  const requestId = randomUUID()
  const options = request.options.map((option) => ({ optionId: option.optionId, kind: option.kind, name: option.name }))
  const answer = await broker.ask({ kind: "permission", requestId, options,
    grantKey: acpGrantKey(request.toolCall.kind, request.toolCall.title),
    permission: { id: requestId, sessionID: sessionId, permission: request.toolCall.kind ?? "other",
      title: request.toolCall.title ?? undefined, patterns: request.toolCall.locations?.map((item) => item.path) ?? [], always: [],
      metadata: { toolCallId: request.toolCall.toolCallId }, harnessPayload: request } })
  return permissionOutcome(answer, options)
}

export function acpGrantKey(kind: string | null | undefined, toolName: string | null | undefined): string | undefined {
  if (typeof toolName !== "string" || toolName.length === 0) return undefined
  return JSON.stringify([kind ?? "other", toolName])
}

function permissionOutcome(answer: RequestAnswer, options: { optionId: string; kind: string }[]): RequestPermissionResponse {
  if (answer.kind !== "permission") return { outcome: { outcome: "cancelled" } }
  const requestedKind = protocolPermissionMapping[answer.decision]
  const chosen = answer.optionId ? options.find((item) => item.optionId === answer.optionId) : options.find((item) => item.kind === requestedKind)
  if (!chosen || chosen.kind !== requestedKind) return { outcome: { outcome: "cancelled" } }
  return { outcome: { outcome: "selected", optionId: chosen.optionId } }
}

export async function acpElicitation(request: CreateElicitationRequest, broker: TurnBroker | SessionBroker): Promise<CreateElicitationResponse> {
  if (request.mode !== "form" && request.mode !== "url") return { action: "cancel" }
  const answer = await broker.ask({ kind: "elicitation", requestId: randomUUID(), mode: request.mode,
    message: request.message, ...("requestedSchema" in request ? { schema: request.requestedSchema } : {}),
    ...("url" in request && typeof request.url === "string" ? { url: request.url,
      ...(typeof request.elicitationId === "string" ? { elicitationId: request.elicitationId } : {}) } : {}) })
  if (answer.kind === "form") return { action: "accept", content: formContent(answer.values) }
  if (answer.kind === "consent") return { action: answer.accepted ? "accept" : "decline" }
  return { action: "cancel" }
}

function formContent(values: Readonly<Record<string, unknown>>): Record<string, ElicitationContentValue> {
  const content: Record<string, ElicitationContentValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") content[key] = value
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) content[key] = value
    else throw new AcpTransportError("protocol", "ACP elicitation answer contains an unsupported value")
  }
  return content
}
