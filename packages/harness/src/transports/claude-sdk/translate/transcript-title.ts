import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"

export function claudeTranscriptTitle(entry: Record<string, unknown>): AgentRuntimeEvent[] {
  if (entry.type !== "ai-title" && entry.type !== "custom-title") return []
  const providerTitle = text(entry[entry.type === "ai-title" ? "aiTitle" : "customTitle"])?.trim()
  return providerTitle ? [{ type: "session-title", title: providerTitle, ...(entry.type === "custom-title" ? { titleSource: "user" } : {}) }] : []
}
