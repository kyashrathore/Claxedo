/** Shared process/agent vocabulary. Both renderers consume this theme mapping. */
export const PROCESS_ICON_GLYPHS = {
  codex: {
    process: "codex-20-050",
    "process-cwd": "codex-20-152",
    subagent: "codex-20-110",
  },
  opencode: {
    process: "terminal",
    "process-cwd": "folder",
    subagent: "subagent",
  },
} as const
