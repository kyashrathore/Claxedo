import type { AgentFilePart } from "@claxedo/agent-runtime-contract"

export function attached(part: AgentFilePart) {
  return part.url.startsWith("data:")
}

export function inline(part: AgentFilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: AgentFilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
