export function hasConcreteSessionTitle(title: unknown) {
  if (typeof title !== "string") return false
  const cleaned = title.replace(/\s+/g, " ").trim()
  if (!cleaned) return false
  if (/^new session$/i.test(cleaned)) return false
  if (/^new session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(cleaned)) return false
  if (/^child session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(cleaned)) return false
  if (/^session$/i.test(cleaned)) return false
  return true
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
    if (!part || typeof part !== "object" || Array.isArray(part)) return []
    const row = part as Record<string, unknown>
    if (typeof row.text === "string") return [row.text]
    if (typeof row.content === "string") return [row.content]
    return []
  }).join("\n").trim()
}
