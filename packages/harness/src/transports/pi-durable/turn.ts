import type { ImageContent, TextContent } from "@earendil-works/pi-ai"
import type { UserInput } from "@earendil-works/pi-durable"
import type { TurnInput } from "../../contract"
import { flattenTurnPrompt, inlineDataUrl } from "../../translate/prompt"
import { piConfiguration } from "./errors"

export function piTurnContent(turn: TurnInput): UserInput {
  const images = turn.prompt.parts.flatMap((part): ImageContent[] => {
    if (part.type !== "file") return []
    const image = inlineDataUrl(part.url, { imageOnly: true, strictBase64: false })
    if (!image) throw piConfiguration("Pi attachments require an inline base64 image; refer to workspace files by path")
    return [{ type: "image", ...image }]
  })
  const text: TextContent = { type: "text", text: flattenTurnPrompt(turn, { separator: "\n", system: "prefix" }) }
  return images.length ? [text, ...images] : text.text
}
