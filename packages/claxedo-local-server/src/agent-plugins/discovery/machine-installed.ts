import { readClaudeInstalled } from "./claude"
import { readCodexInstalled } from "./codex"
import { readCursorInstalled } from "./cursor"
import { readMachineSkills } from "./skills"
import type { MachineInstalledResult } from "./types"

/**
 * D3 "Personal" discovery: what the user installed outside Claxedo — plugins Claude Code, Cursor or Codex
 * registered, and the `SKILL.md` folders any harness keeps machine-wide.
 * Read-only, machine-wide, and never throws — a harness whose files are absent or malformed contributes
 * no entries rather than failing the whole response.
 */
export async function machineInstalledPlugins(input: { home: string; codexHome?: string }): Promise<MachineInstalledResult> {
  const [claude, cursor, codex, skills] = await Promise.all([
    readClaudeInstalled({ home: input.home }),
    readCursorInstalled({ home: input.home }),
    readCodexInstalled({ home: input.home, codexHome: input.codexHome }),
    readMachineSkills(input),
  ])
  return {
    harnesses: [
      { harnessId: "claude", entries: claude },
      { harnessId: "cursor", entries: cursor },
      { harnessId: "codex", entries: codex },
    ],
    skills,
  }
}
