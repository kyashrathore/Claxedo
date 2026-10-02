import { type AgentSessionTitleSource, asRecord } from "@claxedo/agent-runtime-contract"

/**
 * A title no writer chose: empty, or one of the defaults a harness mints at
 * create (`New session - <ISO>` is OpenCode's, `Child session - <ISO>` a
 * subagent's). Only these are replaced by the first-prompt placeholder.
 */
export function isPlaceholderTitle(title: unknown) {
  if (typeof title !== "string") return true
  const cleaned = title.replace(/\s+/g, " ").trim()
  if (!cleaned) return true
  if (/^new session$/i.test(cleaned)) return true
  if (/^new session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(cleaned)) return true
  if (/^child session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(cleaned)) return true
  if (/^session$/i.test(cleaned)) return true
  return false
}

export function deriveSessionTitle(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (/^(hi|hello|hey|yo|greetings)[!. ]*$/i.test(cleaned)) return "Greeting"
  const source = cleaned.replace(/^(please|can you|could you|would you)\s+/i, "").trim() || cleaned
  return source.length > 72 ? source.slice(0, 72).trimEnd() + "..." : source
}

export function extractPromptTitleText(parts: unknown[]) {
  return parts.flatMap((part) => {
    if (typeof part === "string") return [part]
    const row = asRecord(part)
    if (!row) return []
    if (typeof row.text === "string") return [row.text]
    if (typeof row.content === "string") return [row.content]
    return []
  }).join("\n").trim()
}

/** Canonical precedence shared by journal and in-memory projections. */
export function boundSessionTitleSource(title: string | null | undefined, previous?: { title?: string | null; titleSource?: AgentSessionTitleSource }) {
  if (title !== undefined && title !== previous?.title) return isPlaceholderTitle(title) ? undefined : "user" as const
  return previous?.titleSource
}

export function acceptsSessionTitle(source: AgentSessionTitleSource | undefined, previous: AgentSessionTitleSource | undefined) {
  const rank = { prompt: 0, harness: 1, user: 2 }
  return rank[source ?? "prompt"] >= rank[previous ?? "prompt"]
}
