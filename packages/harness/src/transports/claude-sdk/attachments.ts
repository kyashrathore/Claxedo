import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TurnInput } from "../../contract"
import { flattenTurnPrompt } from "../../translate/prompt"
import { attachmentErrorFor, attachmentPathLine, materializeAttachment, turnAttachments } from "../../translate/attachments"

type Block = Exclude<SDKUserMessage["message"]["content"], string>[number]
const images = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const

const attachmentError = attachmentErrorFor("claude")

export async function claudePrompt(turn: TurnInput, directory: string): Promise<SDKUserMessage> {
  const text = flattenTurnPrompt(turn, { system: "prompt", separator: "\n\n" })
  const blocks: Block[] = []
  const paths: string[] = []
  for (const file of turnAttachments(turn, attachmentError)) {
    const written = await materializeAttachment(directory, file, attachmentError)
    paths.push(attachmentPathLine(written))
    const imageMime = images.find((mime) => mime === file.mime)
    if (imageMime) blocks.push({ type: "image", source: { type: "base64", media_type: imageMime, data: file.base64 } })
    if (file.mime === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } })
  }
  blocks.push({ type: "text", text: [text, ...paths].filter(Boolean).join("\n") })
  return { type: "user", session_id: "", message: { role: "user", content: blocks }, parent_tool_use_id: null }
}
