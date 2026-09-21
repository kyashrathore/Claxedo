import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeToolAttachment } from "../contracts/agent-runtime-event"
import { text } from "../value"

/**
 * Maximum encoded image characters carried in one canonical attachment. Oversized
 * results are explicit unavailable attachments, never replaced with a path.
 */
export const TOOL_ATTACHMENT_INLINE_MAX_BYTES = 128 * 1024

export function attachmentUrl(mime: string, data: string) {
  return data.startsWith("data:") ? data : `data:${mime};base64,${data}`
}

/** Base64 spends four characters per three bytes, and pads the last group out. */
function decodedBase64Bytes(payload: string) {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/**
 * The size of the image, not of the encoding that carried it — a view reports this
 * as the file size, and base64 is a third larger than what it stands for.
 */
export function attachmentBytes(data: string) {
  if (!data.startsWith("data:")) return decodedBase64Bytes(data)
  const comma = data.indexOf(",")
  if (comma < 0) return 0
  const payload = data.slice(comma + 1)
  return data.slice(0, comma).includes(";base64") ? decodedBase64Bytes(payload) : payload.length
}

/**
 * Preserve the image supplied by the tool, even when its input named a file.
 * Reading that file later could return different pixels.
 */
export function imageAttachment(input: {
  mime: string
  data: string
  filename?: string
  sourcePath?: string
}): RuntimeToolAttachment {
  const named = input.filename ? { filename: input.filename } : {}
  // Measured on the payload rather than on the url: building the url to measure it
  // copies an oversized image that the bound is about to refuse.
  if (input.data.length <= TOOL_ATTACHMENT_INLINE_MAX_BYTES) {
    return { kind: "inline", mime: input.mime, url: attachmentUrl(input.mime, input.data), ...named }
  }
  return {
    kind: "unretained",
    mime: input.mime,
    bytes: attachmentBytes(input.data),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...named,
  }
}

/** The MCP/ACP content-block image, shared by Codex MCP results and Pi tool results. */
export function contentBlockImages(content: unknown): RuntimeToolAttachment[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    const block = asRecord(item)
    if (block?.type !== "image") return []
    const mime = text(block.mimeType)
    const data = text(block.data)
    if (!mime?.startsWith("image/") || !data) return []
    return [imageAttachment({ mime, data })]
  })
}

/** A bare image url carries no media type, so only a data url can name one. */
export function imageUrlAttachment(url: unknown): RuntimeToolAttachment[] {
  const value = text(url)
  const mime = value ? /^data:([^;,]+)[;,]/.exec(value)?.[1] : undefined
  return value && mime ? [imageAttachment({ mime, data: value })] : []
}
