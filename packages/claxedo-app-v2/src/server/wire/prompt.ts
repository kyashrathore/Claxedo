import type { PromptInput as RuntimePromptInput } from "@claxedo/agent-runtime-contract"
import type { PromptAttachment, PromptInput } from "../types"

export const DEFAULT_AGENT = "build"

type WirePart = RuntimePromptInput["parts"][number]

function attachmentPart(attachment: PromptAttachment): WirePart {
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

export function promptBody(input: PromptInput, messageId: string) {
  return {
    messageID: messageId,
    agent: input.agent ?? DEFAULT_AGENT,
    ...(input.model ? { model: { providerID: input.model.providerId, modelID: input.model.modelId } } : {}),
    ...(input.model?.variant !== undefined ? { variant: input.model.variant } : {}),
    ...(input.effort !== undefined ? { variant: input.effort } : {}),
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    parts: [{ type: "text", text: input.text } as WirePart, ...input.attachments.map(attachmentPart)],
  }
}
