// Request-part preparation and optimistic timeline reconciliation for the
// prompt submit pipeline.
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Identifier } from "@/lib/id"
import { type ImageAttachmentPart, type Prompt } from "@/features/session/providers/prompt"
import { buildRequestParts } from "@/features/session/composer/ui/build-request-parts"
import type { PreparedPromptRequest, PromptContextItem, PromptTimelineOptimisticStore, SubmittedConfig } from "./types"

export function isPageCommentPath(path: string | undefined) {
  return !!path && (path.startsWith("http://") || path.startsWith("https://") || path === "page")
}

export function preparePromptRequest(input: {
  prompt: Prompt
  contextItems: PromptContextItem[]
  images: ImageAttachmentPart[]
  text: string
  sessionID: string
  sessionDirectory: string
  messageID?: string
}): PreparedPromptRequest {
  const pageCommentItems = input.contextItems.filter((item) => item.type === "file" && isPageCommentPath(item.path))
  const context = input.contextItems.filter((item) => !(item.type === "file" && isPageCommentPath(item.path)))
  const messageID = input.messageID ?? Identifier.ascending("message")
  const builtParts = buildRequestParts({
    prompt: input.prompt,
    context,
    images: input.images,
    text: input.text,
    sessionID: input.sessionID,
    messageID,
    sessionDirectory: input.sessionDirectory,
  })

  const requestParts = builtParts.requestParts
  const optimisticParts = builtParts.optimisticParts

  // Browser-tab page comments share the FileContextItem shape with a URL-shaped
  // `path`. `buildRequestParts` would turn that into a `file://http://...`
  // attachment, so keep them as synthetic text-only parts.
  for (const item of pageCommentItems) {
    const comment = item.comment?.trim()
    if (!comment) continue
    const textPart = {
      id: Identifier.ascending("part"),
      type: "text" as const,
      text: comment,
    }
    requestParts.push(textPart)
    optimisticParts.push({
      ...textPart,
      sessionID: input.sessionID,
      messageID,
    })
  }

  return {
    messageID,
    requestParts,
    optimisticParts,
    submittedCommentItems: [
      ...context.filter((item) => item.type === "file" && !!item.comment?.trim()),
      ...pageCommentItems,
    ],
  }
}

export function createPromptTimelineReconciliation(input: {
  optimistic: PromptTimelineOptimisticStore
  promptRequest: PreparedPromptRequest
  sessionID: string
  sessionDirectory: string
  agent: string
  model: SubmittedConfig["model"]
  variant?: string
}) {
  const submittedMessage: Message = {
    id: input.promptRequest.messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.agent,
    model: { ...input.model, ...(input.variant ? { variant: input.variant } : {}) },
  }

  return {
    addSubmittedPrompt: () => {
      input.optimistic.add({
        directory: input.sessionDirectory,
        sessionID: input.sessionID,
        message: submittedMessage,
        parts: input.promptRequest.optimisticParts,
      })
    },
    removeSubmittedPrompt: () => {
      input.optimistic.remove({
        directory: input.sessionDirectory,
        sessionID: input.sessionID,
        messageID: input.promptRequest.messageID,
      })
    },
    addDemoReply: (reply: { info: Message; parts: Part[] }) => {
      input.optimistic.add({
        directory: input.sessionDirectory,
        sessionID: input.sessionID,
        message: reply.info,
        parts: reply.parts,
      })
    },
  }
}
