import type { Part } from "@opencode-ai/sdk/v2"

export const messageNavVisible = (turnCount: number) => turnCount > 10

export const messageNavCurrentID = (turns: { id: string; start: number }[], line: number) =>
  turns.findLast((turn) => turn.start <= line)?.id ?? turns[0]?.id

export function messageNavPreview(input: {
  userMessageID: string
  assistantMessageIDs: string[]
  getParts: (messageID: string) => Part[]
}) {
  return {
    user: previewText(input.getParts(input.userMessageID)),
    assistant: previewText(input.assistantMessageIDs.flatMap(input.getParts)),
  }
}

function previewText(parts: Part[]) {
  return (
    parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim() || undefined
  )
}
