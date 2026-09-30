import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"

export function claudeTranscriptTitle(entry: Record<string, unknown>): AgentRuntimeEvent[] {
  if (entry.type === "ai-title") {
    const title = text(entry.aiTitle)?.trim()
    return title ? [{ type: "session-title", title }] : []
  }
  if (entry.type === "custom-title") {
    const title = text(entry.customTitle)?.trim()
    return title ? [{ type: "session-title", title, titleSource: "user" }] : []
  }
  return []
}
