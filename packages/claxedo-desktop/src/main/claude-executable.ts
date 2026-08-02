import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join, win32 } from "node:path"

/**
 * Locate the Claude Code CLI the user has installed. The desktop app never
 * bundles it — the native harness spawns it via the SDK's
 * pathToClaudeCodeExecutable and the ACP adapter reads CLAUDE_CODE_EXECUTABLE.
 * A GUI-launched app often has a trimmed PATH, so we also probe the standard
 * install locations. Returns `undefined` when Claude Code is not installed.
 *
 * (agent-sdk-runtime has a richer resolver, but claxedo-desktop's main process
 * does not depend on it, so this keeps a minimal copy.)
 */
export function resolveSystemClaude(): string | undefined {
  const isWin = process.platform === "win32"
  const bin = isWin ? "claude.exe" : "claude"

  const executable = (candidate: string): boolean => {
    try {
      if (!statSync(candidate).isFile()) return false
      if (isWin) return true
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const dir = entry.trim()
    if (!dir) continue
    const candidate = isWin ? win32.join(dir, bin) : join(dir, bin)
    if (executable(candidate)) return candidate
  }

  const home = homedir()
  const candidates = [join(home, ".local", "bin", bin)]
  if (process.platform === "darwin") {
    candidates.push(join("/opt/homebrew/bin", bin), join("/usr/local/bin", bin))
  } else if (process.platform === "linux") {
    candidates.push(join("/usr/local/bin", bin), join("/usr/bin", bin))
  }
  return candidates.find(executable)
}
