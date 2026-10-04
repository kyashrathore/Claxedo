import type { AgentContentPart, RuntimeToolAttachment } from "@claxedo/agent-runtime-contract"
import type { CompatContext } from "./context"

export function dataUrl(mime: string, data: string) {
  if (data.startsWith("data:")) return data
  return `data:${mime};base64,${data}`
}

export function extension(mime: string) {
  const subtype = mime.split("/")[1]?.split(";")[0]
  if (!subtype) return "bin"
  if (subtype === "jpeg") return "jpg"
  return subtype.replace(/[^a-z0-9]/gi, "") || "bin"
}

export function filePart(input: {
  ctx: CompatContext
  id: string
  mime: string
  url: string
  filename?: string
  location?: Extract<AgentContentPart, { type: "file" }>["location"]
  source?: Extract<AgentContentPart, { type: "file" }>["source"]
}): Extract<AgentContentPart, { type: "file" }> {
  return {
    id: input.id,
    sessionID: input.ctx.sessionId,
    messageID: input.ctx.assistantMsgId,
    type: "file",
    mime: input.mime,
    url: input.url,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.source ? { source: input.source } : {}),
  }
}

function attachmentFilename(attachment: RuntimeToolAttachment) {
  if (attachment.filename) return attachment.filename
  return `${attachment.mime.startsWith("image/") ? "image" : "attachment"}.${extension(attachment.mime)}`
}

/**
 * Names a file the part did not inline. Nothing fetches this — `location` carries
 * what the file route is asked for — but `file://` is followed by an authority, so
 * a workspace-relative path spelled into one turns its first segment into a host:
 * `file://docs/shot.webp` names the host `docs`. Only an absolute path takes the
 * scheme; a relative one stays a relative reference.
 */
function fileLocator(path: string) {
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  return path.startsWith("/") ? `file://${encoded}` : encoded
}

export function attachmentPart(ctx: CompatContext, id: string, attachment: RuntimeToolAttachment) {
  const common = { ctx, id, mime: attachment.mime, filename: attachmentFilename(attachment) }
  if (attachment.kind === "inline") return filePart({ ...common, url: attachment.url })
  if (attachment.kind === "tool-file") {
    return filePart({ ...common, url: "", location: { kind: "tool-file", path: attachment.path } })
  }
  if (attachment.kind === "workspace-file") {
    return filePart({ ...common, url: fileLocator(attachment.path), location: { kind: "workspace-file", path: attachment.path } })
  }
  return filePart({
    ...common,
    url: attachment.sourcePath ? fileLocator(attachment.sourcePath) : "",
    location: { kind: "unretained", bytes: attachment.bytes },
  })
}
