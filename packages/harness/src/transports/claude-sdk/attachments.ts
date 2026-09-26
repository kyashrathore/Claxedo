import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TurnInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { flattenTurnPrompt } from "../../translate/prompt"
import { attachmentPathLine, isPromptImage, materializeAttachment, promptFiles } from "../../translate/attachments"

type Block = Exclude<SDKUserMessage["message"]["content"], string>[number]

const claudeAttachmentError = (message: string) => new TransportError("claude", "configuration", message)

export async function claudePrompt(turn: TurnInput, directory: string): Promise<SDKUserMessage> {
  const text = flattenTurnPrompt(turn, { system: "prompt", separator: "\n\n" })
  const { files, references } = promptFiles(turn, claudeAttachmentError)
  if (references.length) throw claudeAttachmentError("Claude cannot deliver this file URL")
  const blocks: Block[] = []
  const paths: string[] = []
  for (const file of files) {
    paths.push(attachmentPathLine(await materializeAttachment(directory, file, claudeAttachmentError)))
    if (isPromptImage(file.mime)) blocks.push({ type: "image", source: { type: "base64", media_type: file.mime, data: file.base64 } })
    if (file.mime === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } })
  }
  blocks.push({ type: "text", text: [text, ...paths].filter(Boolean).join("\n") })
  return { type: "user", session_id: "", message: { role: "user", content: blocks }, parent_tool_use_id: null }
}
