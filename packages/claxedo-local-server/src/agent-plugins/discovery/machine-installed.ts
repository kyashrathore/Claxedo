import { readClaudeInstalled } from "./claude"
import { readCodexInstalled } from "./codex"
import { readCursorInstalled } from "./cursor"
import type { MachineInstalledResult } from "./types"

/**
 * D3 "Personal" discovery: plugins the user installed for Claude Code, Cursor, or Codex outside Claxedo.
 * Read-only, machine-wide, and never throws — a harness whose files are absent or malformed contributes
 * no entries rather than failing the whole response.
 */
export async function machineInstalledPlugins(input: { home: string; codexHome?: string }): Promise<MachineInstalledResult> {
  const [claude, cursor, codex] = await Promise.all([
    readClaudeInstalled({ home: input.home }),
    readCursorInstalled({ home: input.home }),
    readCodexInstalled({ home: input.home, codexHome: input.codexHome }),
  ])
  return {
    harnesses: [
      { harnessId: "claude", entries: claude },
      { harnessId: "cursor", entries: cursor },
      { harnessId: "codex", entries: codex },
    ],
  }
}
