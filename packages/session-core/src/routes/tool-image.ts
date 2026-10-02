import type { AgentMessage } from "@claxedo/agent-runtime-contract"

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export type AttachmentReader = (path: string, maximumBytes: number) => Promise<Uint8Array | "too-large" | undefined>

function imageMime(bytes: Uint8Array) {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (/^GIF8[79]a/.test(ascii(0, 6))) return "image/gif"
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  return undefined
}

export async function toolImageResponse(input: {
  messages: AgentMessage[]
  sessionId: string
  messageId: string
  attachmentId: string
  readAttachment?: AttachmentReader
}): Promise<Response> {
  const missing = () => new Response("Image unavailable", { status: 404, headers: { "cache-control": "no-store" } })
  const message = input.messages.find((message) => message.info.id === input.messageId &&
    message.info.sessionID === input.sessionId && message.info.role === "assistant")
  const attachment = message?.parts.flatMap((part) => part.type === "tool" &&
    part.sessionID === input.sessionId && part.messageID === input.messageId && part.state.status === "completed"
    ? part.state.attachments ?? [] : []).find((file) => file.id === input.attachmentId &&
      file.sessionID === input.sessionId && file.messageID === input.messageId)
  if (attachment?.location?.kind !== "tool-file" || !attachment.mime.startsWith("image/") || !input.readAttachment) return missing()
  try {
    const bytes = await input.readAttachment(attachment.location.path, MAX_IMAGE_BYTES)
    if (bytes === "too-large" || bytes && bytes.length > MAX_IMAGE_BYTES) {
      return new Response("Image exceeds 20 MiB", { status: 413, headers: { "cache-control": "no-store" } })
    }
    if (!bytes?.length) return missing()
    const mime = imageMime(bytes)
    if (!mime) return new Response("Unsupported image", { status: 415, headers: { "cache-control": "no-store" } })
    return new Response(new Uint8Array(bytes), { headers: {
      "content-type": mime, "content-length": String(bytes.length), "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
    } })
  } catch { return missing() }
}
