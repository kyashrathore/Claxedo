import { pathToFileURL } from "node:url"
import path from "node:path"
import type {
  ContentBlock, CreateElicitationRequest, CreateElicitationResponse, ElicitationContentValue, McpServer, PromptCapabilities,
  RequestPermissionRequest, RequestPermissionResponse,
} from "@agentclientprotocol/sdk"
import type { McpServerSpec, RequestAnswer, SessionBroker, TurnBroker, TurnInput } from "../../contract"
import type { PermissionDecision } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { AcpTransportError } from "./errors"
import { elicitationAnswer, elicitationRequest, permissionRequest, permissionSelection } from "../../contract"
import { flattenTurnPrompt } from "../../translate/prompt"
import { attachmentPathLine, isPromptImage, materializeAttachment, promptFiles, type MaterializedFile, type PromptFile } from "../../translate/attachments"

const protocolPermissionMapping: Record<PermissionDecision, string> = {
  allow_once: "allow_once", allow_always: "allow_always", deny: "reject_once", reject_always: "reject_always",
}

export type AcpPromptDelivery = { capabilities: PromptCapabilities | null | undefined; sharedDirectory?: string }

const acpAttachmentError = (message: string) => new AcpTransportError("configuration", message)

export function acpMcp(server: McpServerSpec): McpServer {
  if (server.kind === "stdio") return { name: server.name, command: server.command,
    args: [...server.args ?? []], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) }
  return { type: server.kind, name: server.name, url: server.url,
    headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
}

function acpAttachmentBlock(file: PromptFile | MaterializedFile, index: number, capabilities: AcpPromptDelivery["capabilities"]): ContentBlock {
  const written = "path" in file ? file.path : undefined
  if (capabilities?.image && isPromptImage(file.mime)) {
    return { type: "image", mimeType: file.mime, data: file.base64, ...(written ? { uri: pathToFileURL(written).href } : {}) }
  }
  if (capabilities?.audio && file.mime.startsWith("audio/")) return { type: "audio", mimeType: file.mime, data: file.base64 }
  if (capabilities?.embeddedContext) {
    return { type: "resource", resource: { uri: written ? pathToFileURL(written).href : `wr://attachment/${index}`, blob: file.base64, mimeType: file.mime } }
  }
  if (written) return { type: "resource_link", uri: pathToFileURL(written).href, name: file.filename ?? path.basename(written), mimeType: file.mime }
  throw acpAttachmentError(`ACP agent cannot receive a ${file.mime} attachment: it negotiated no inline content and does not share the workspace`)
}

export async function acpPrompt(turn: TurnInput, delivery: AcpPromptDelivery): Promise<ContentBlock[]> {
  const { files, references } = promptFiles(turn, acpAttachmentError)
  const attachments: (PromptFile | MaterializedFile)[] = []
  for (const file of files) attachments.push(delivery.sharedDirectory ? await materializeAttachment(delivery.sharedDirectory, file, acpAttachmentError) : file)
  const lines = attachments.flatMap((file) => "path" in file ? [attachmentPathLine(file)] : [])
  const text = [flattenTurnPrompt(turn, { separator: "\n\n", system: "prefix" }), ...lines].filter(Boolean).join("\n")
  const blocks: ContentBlock[] = text ? [{ type: "text", text }] : []
  attachments.forEach((file, index) => blocks.push(acpAttachmentBlock(file, index, delivery.capabilities)))
  for (const uri of references) blocks.push({ type: "resource_link", uri, name: uri })
  return blocks
}

export async function acpPermission(request: RequestPermissionRequest, broker: TurnBroker | SessionBroker, sessionId: string,
  askOptions?: { signal?: AbortSignal }): Promise<RequestPermissionResponse> {
  const options = request.options.map((option) => ({ optionId: option.optionId, kind: option.kind, name: option.name }))
  const title = request.toolCall.title ?? undefined
  const raw = asRecord(request.toolCall.rawInput)
  const command = typeof raw?.command === "string" ? raw.command : undefined
  const paths = request.toolCall.locations?.map((item) => item.path) ?? []
  const answer = await broker.ask(permissionRequest({ sessionId, options,
    grantKey: acpGrantKey(request.toolCall.kind, request.toolCall.title),
    permission: request.toolCall.kind ?? "other",
    title, patterns: paths, always: paths,
    metadata: { toolCallId: request.toolCall.toolCallId, ...(title === undefined ? {} : { title, reason: title }),
      ...(command === undefined ? {} : { command }), acpToolCall: request.toolCall, ...(request._meta ? { acpRequestMeta: request._meta } : {}) },
    harnessPayload: request }), askOptions)
  return permissionOutcome(answer, options)
}

export function acpGrantKey(kind: string | null | undefined, toolName: string | null | undefined): string | undefined {
  if (typeof toolName !== "string" || toolName.length === 0) return undefined
  return JSON.stringify([kind ?? "other", toolName])
}

function permissionOutcome(answer: RequestAnswer, options: { optionId: string; kind: string }[]): RequestPermissionResponse {
  const selection = permissionSelection(answer)
  if (!selection) return { outcome: { outcome: "cancelled" } }
  const requestedKind = protocolPermissionMapping[selection.decision]
  const chosen = selection.optionId ? options.find((item) => item.optionId === selection.optionId) : options.find((item) => item.kind === requestedKind)
  if (!chosen || chosen.kind !== requestedKind) return { outcome: { outcome: "cancelled" } }
  return { outcome: { outcome: "selected", optionId: chosen.optionId } }
}

export async function acpElicitation(request: CreateElicitationRequest, broker: TurnBroker | SessionBroker,
  options?: { signal?: AbortSignal }): Promise<CreateElicitationResponse> {
  if (request.mode !== "form" && request.mode !== "url") return { action: "cancel" }
  const answer = elicitationAnswer(await broker.ask(elicitationRequest({ mode: request.mode,
    message: request.message, ...("requestedSchema" in request ? { schema: request.requestedSchema } : {}),
    ...("url" in request && typeof request.url === "string" ? { url: request.url,
      ...(typeof request.elicitationId === "string" ? { elicitationId: request.elicitationId } : {}) } : {}) }), options))
  if (answer.kind === "form") return { action: "accept", content: formContent(answer.values) }
  if (answer.kind === "consent") return { action: answer.accepted ? "accept" : "decline" }
  if (answer.kind === "decline") return { action: "decline" }
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
