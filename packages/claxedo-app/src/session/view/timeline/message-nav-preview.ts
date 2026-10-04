import type { AgentContentPart as Part } from "@claxedo/agent-runtime-contract"

export const messageNavVisible = (turnCount: number) => turnCount > 10

export function messageNavPreview(input: {
  userMessageId: string
  assistantMessageIds: string[]
  getParts: (messageId: string) => Part[]
}) {
  return {
    user: previewText(input.getParts(input.userMessageId)),
    assistant: previewText(input.assistantMessageIds.flatMap(input.getParts)),
  }
}

function previewText(parts: Part[]) {
  return parts
    .flatMap((part) => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim() || undefined
}
