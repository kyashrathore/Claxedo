import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeToolAttachment } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { TOOL_ATTACHMENT_INLINE_MAX_BYTES, imageAttachment } from "../../../translate/tool-attachments"

const IMAGE_SIGNATURES: ReadonlyArray<readonly [prefix: string, mime: string]> = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["UklGR", "image/webp"],
  ["R0lGOD", "image/gif"],
]

export function imageFileAttachment(path: string, mime: string): RuntimeToolAttachment {
  return { kind: "tool-file", mime, path, filename: path.split(/[\\/]/).pop() }
}

export function generatedImageAttachments(completed: Record<string, unknown>): RuntimeToolAttachment[] {
  const data = text(completed.result)
  const savedPath = text(completed.savedPath)
  if (!data) return savedPath ? [imageFileAttachment(savedPath, "image/*")] : []
  const mime = IMAGE_SIGNATURES.find(([prefix]) => data.startsWith(prefix))?.[1] ?? "image/png"
  if (data.length > TOOL_ATTACHMENT_INLINE_MAX_BYTES && savedPath) return [imageFileAttachment(savedPath, mime)]
  return [imageAttachment({ mime, data, ...(savedPath ? { sourcePath: savedPath } : {}) })]
}

export function generatedImageFailure(completed: Record<string, unknown>) {
  if (asRecord(completed.failure)?.type === "usageLimitExceeded") return "Image generation stopped: usage limit reached"
  return completed.status === "failed" ? "Image generation failed" : undefined
}
