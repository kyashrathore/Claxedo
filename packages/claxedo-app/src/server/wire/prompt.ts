import { promptPartId, type AgentContentPart, type AgentUserMessage, type PromptInput as RuntimePromptInput } from "@claxedo/agent-runtime-contract"
import type { PromptAttachment, PromptDelivery, PromptInput } from "../types"

export const PROMPT_ROUTE = "/prompt_async"

const DEFAULT_AGENT = "build"

type WirePart = RuntimePromptInput["parts"][number]

function wireAttachmentPart(attachment: PromptAttachment): WirePart {
  switch (attachment.kind) {
    case "file":
      return {
        type: "file",
        mime: attachment.mime ?? "text/plain",
        filename: attachment.path.split("/").pop() ?? attachment.path,
        url: `file://${attachment.path}`,
        source: { type: "file", path: attachment.path, text: { value: `@${attachment.path}`, start: 0, end: 0 } },
      }
    case "image":
      return {
        type: "file",
        mime: attachment.mime,
        filename: attachment.name ?? "image",
        url: attachment.dataUrl,
      }
    case "text":
      return { type: "text", text: attachment.label ? `${attachment.label}\n${attachment.text}` : attachment.text, synthetic: true }
  }
}

const wireModel = (input: PromptInput) => (input.model ? { model: { providerID: input.model.providerId, modelID: input.model.modelId } } : {})

function promptParts(input: PromptInput): WirePart[] {
  return [{ type: "text", text: input.text } as WirePart, ...input.attachments.map(wireAttachmentPart)]
}

export function promptBody(input: PromptInput, messageId: string) {
  return {
    messageID: messageId,
    agent: input.agent ?? DEFAULT_AGENT,
    ...wireModel(input),
    ...(input.model?.variant !== undefined ? { variant: input.model.variant } : {}),
    ...(input.effort !== undefined ? { variant: input.effort } : {}),
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    parts: promptParts(input),
  }
}

export function promptEcho(input: PromptInput, ids: { readonly sessionId: string; readonly messageId: string; readonly created: number }): { info: AgentUserMessage; parts: AgentContentPart[] } {
  const { sessionId, messageId } = ids
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: { created: ids.created },
      agent: input.agent ?? DEFAULT_AGENT,
      ...wireModel(input),
    },
    parts: promptParts(input).map((part, index) => ({ ...part, id: promptPartId(messageId, index), sessionID: sessionId, messageID: messageId })),
  }
}

export function promptDeliveryFromWire(body: unknown): PromptDelivery {
  const delivery = body && typeof body === "object" ? (body as { delivery?: unknown }).delivery : undefined
  if (delivery === "queue" || delivery === "steer") return delivery
  return body === undefined ? "start" : "steer"
}
