export const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  "claude-sdk": "Claude SDK",
  "codex-app-server": "Codex App Server",
  "cursor-sdk": "Cursor SDK",
  agent: "Cursor",
  "cursor-agent": "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
}

/**
 * Display label for ANY harness key: the built-in table wins; an operator ACP
 * connection key (`acp:<slug>`) falls back to a title-cased slug. The
 * server-provided connection label is preferred wherever discovery data is at
 * hand — this is the label of last resort for keys rendered without it
 * (historical sessions, removed connections).
 */
export function harnessDisplayLabel(key: string): string {
  const hit = HARNESS_DISPLAY_NAMES[key]
  if (hit) return hit
  const slug = key.startsWith("acp:") ? key.slice("acp:".length) : key
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((item) => item[0]?.toUpperCase() + item.slice(1))
    .join(" ")
}
