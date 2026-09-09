/** Explicit artwork choices shared by every theme. Unlisted icons use their theme's family. */
export const ICON_ARTWORK_POLICY = {
  globe: "codex",
  cloud: "codex",
  gauge: "codex",
  reload: "codex",
  reset: "codex",
  worktree: "codex",
  discord: "opencode",
  // Processes and terminals share OpenCode's >_ mark in every theme and state.
  process: "opencode",
  terminal: "opencode",
  "terminal-active": "opencode",
} as const

export function resolveIconArtworkLibrary(name: string, themeLibrary: "codex" | "opencode") {
  return (ICON_ARTWORK_POLICY as Record<string, "codex" | "opencode" | undefined>)[name] ?? themeLibrary
}
