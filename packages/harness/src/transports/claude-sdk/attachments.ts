import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TurnInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { isPromptImage, writtenPrompt } from "../../translate/attachments"

type Block = Exclude<SDKUserMessage["message"]["content"], string>[number]

const claudeAttachmentError = (message: string) => new TransportError("claude", "configuration", message)

export async function claudePrompt(turn: TurnInput, directory: string): Promise<SDKUserMessage> {
  const { text, files } = await writtenPrompt(turn, directory,
    { program: "Claude", flatten: { separator: "\n\n", system: "channel" }, error: claudeAttachmentError })
  const blocks: Block[] = []
  for (const file of files) {
    if (isPromptImage(file.mime)) blocks.push({ type: "image", source: { type: "base64", media_type: file.mime, data: file.base64 } })
    if (file.mime === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } })
  }
  blocks.push({ type: "text", text })
  return { type: "user", session_id: "", message: { role: "user", content: blocks }, parent_tool_use_id: null }
}
