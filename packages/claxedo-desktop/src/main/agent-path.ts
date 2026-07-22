import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

/**
 * Standard directories agent CLIs install into that a GUI-launched app's
 * trimmed PATH usually omits. Kept in preference order.
 */
function standardBinDirs(): string[] {
  const home = homedir()
  if (process.platform === "darwin") {
    return [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
  }
  if (process.platform === "linux") {
    return [join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin"]
  }
  return []
}

/**
 * Prepend the standard agent-install directories to PATH so the harnesses can
 * find the user's system-installed CLIs (`claude`, `codex`, `cursor-agent`,
 * `gemini`) when the app was launched from Finder/Dock with a trimmed PATH.
 * Both the embedded claxedo-server (this process) and the spawned sidecar
 * (inherits this env) then resolve them. Idempotent.
 */
export function ensureAgentPath(): void {
  const existing = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const present = new Set(existing)
  const additions = standardBinDirs().filter((dir) => existsSync(dir) && !present.has(dir))
  if (additions.length === 0) return
  process.env.PATH = [...additions, ...existing].join(delimiter)
}
