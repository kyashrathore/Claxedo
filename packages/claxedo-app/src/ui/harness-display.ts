export const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
}

/**
 * Display label for a native id or opaque connection id. The
 * server-provided connection label is preferred wherever discovery data is at
 * hand — this is the label of last resort for keys rendered without it
 * (historical sessions, removed connections).
 */
export function harnessDisplayLabel(key: string): string {
  const hit = HARNESS_DISPLAY_NAMES[key]
  if (hit) return hit
  return key
    .split(/[-_]/g)
    .filter(Boolean)
    .map((item) => item[0]?.toUpperCase() + item.slice(1))
    .join(" ")
}
