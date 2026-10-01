import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"

export function claudeTranscriptTitle(entry: SessionStoreEntry): Extract<AgentRuntimeEvent, { type: "session-title" }>[] {
  if (entry.type === "ai-title") {
    const providerTitle = text(entry.aiTitle)?.trim()
    return providerTitle ? [{ type: "session-title", title: providerTitle }] : []
  }
  if (entry.type === "custom-title") {
    const providerTitle = text(entry.customTitle)?.trim()
    return providerTitle ? [{ type: "session-title", title: providerTitle, titleSource: "user" }] : []
  }
  return []
}
