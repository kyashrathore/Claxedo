import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { AgentMessage } from "@claxedo/agent-runtime-contract"

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "image/gif"
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  return undefined
}

/** Read only an image explicitly attached to an assistant's completed tool result. */
export async function toolImageResponse(input: {
  messages: AgentMessage[]
  sessionId: string
  messageId: string
  attachmentId: string
}): Promise<Response> {
  const missing = () => new Response("Image unavailable", { status: 404, headers: { "cache-control": "no-store" } })
  const message = input.messages.find((message) => message.info.id === input.messageId &&
    message.info.sessionID === input.sessionId && message.info.role === "assistant")
  const attachment = message?.parts.flatMap((part) => part.type === "tool" &&
    part.sessionID === input.sessionId && part.messageID === input.messageId && part.state.status === "completed"
    ? part.state.attachments ?? [] : []).find((file) => file.id === input.attachmentId &&
      file.sessionID === input.sessionId && file.messageID === input.messageId)
  if (attachment?.location?.kind !== "tool-file" || !attachment.mime.startsWith("image/") ||
    !path.isAbsolute(attachment.location.path)) return missing()

  try {
    const file = await fs.open(attachment.location.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size === 0) return missing()
      if (stat.size > MAX_IMAGE_BYTES) return new Response("Image exceeds 20 MiB", { status: 413, headers: { "cache-control": "no-store" } })
      // Bound allocation even if another process grows the file during this read.
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) return missing()
        offset += read.bytesRead
      }
      const mime = imageMime(bytes)
      if (!mime) return new Response("Unsupported image", { status: 415, headers: { "cache-control": "no-store" } })
      return new Response(new Uint8Array(bytes), { headers: {
        "content-type": mime,
        "content-length": String(bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      } })
    } finally {
      await file.close()
    }
  } catch {
    return missing()
  }
}
