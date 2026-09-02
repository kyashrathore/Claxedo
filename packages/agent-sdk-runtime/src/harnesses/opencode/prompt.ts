import type { CompatEvent, CompatPart } from "../../compat-events"

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function dataUrl(mime: string, data: string) {
  if (data.startsWith("data:")) return data
  return `data:${mime};base64,${data}`
}

function extension(mime: string) {
  const subtype = mime.split("/")[1]?.split(";")[0]
  if (!subtype) return "bin"
  if (subtype === "jpeg") return "jpg"
  return subtype.replace(/[^a-z0-9]/gi, "") || "bin"
}

export function promptParts(sessionId: string, messageId: string, parts: unknown[]): CompatPart[] {
  return parts.flatMap((item, index) => {
    const row = record(item)
    const type = typeof row?.type === "string" ? row.type : undefined
    const id = `${String(index).padStart(6, "0")}_${messageId}-input`
    if (type === "text") {
      return [{ id, sessionID: sessionId, messageID: messageId, type, text: typeof row?.text === "string" ? row.text : "" } satisfies CompatPart]
    }
    if ((type === "image" || type === "audio") && typeof row?.mimeType === "string" && typeof row?.data === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        mime: row.mimeType,
        url: dataUrl(row.mimeType, row.data),
        filename: `${type}.${extension(row.mimeType)}`,
      } satisfies CompatPart]
    }
    if (type === "resource_link" && typeof row?.uri === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        mime: typeof row.mimeType === "string" ? row.mimeType : "application/octet-stream",
        url: row.uri,
        filename: typeof row.name === "string" ? row.name : typeof row.title === "string" ? row.title : "resource",
      } satisfies CompatPart]
    }
    const resource = record(row?.resource)
    if (type === "resource" && typeof resource?.text === "string") {
      return [{ id, sessionID: sessionId, messageID: messageId, type: "text", text: resource.text } satisfies CompatPart]
    }
    return [] as CompatPart[]
  })
}

export function eventHasVisibleAssistantContent(event: CompatEvent) {
  if (event.type === "message.part.updated") {
    const part = event.properties.part as { text?: unknown; content?: unknown }
    const content = typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : ""
    return content.trim().length > 0
  }
  if (event.type === "message.part.delta") {
    const row = event.properties as { field?: unknown; delta?: unknown }
    return (row.field === "text" || row.field === "content") && typeof row.delta === "string" && row.delta.trim().length > 0
  }
  return false
}

export function eventIsError(event: CompatEvent) {
  return event.type === "session.error"
}
