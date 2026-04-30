/**
 * Platform Detection & Helpers
 *
 * Centralizes all platform-specific logic for agent-hooks.
 * Every function accepts an optional `platform` parameter for testability
 * (same pattern as pty/env.ts).
 */

import * as path from "path"

// ── Detection ─────────────────────────────────────────────────────────────

export function isWindows(platform?: NodeJS.Platform): boolean {
  return (platform ?? process.platform) === "win32"
}

export function isMacOS(platform?: NodeJS.Platform): boolean {
  return (platform ?? process.platform) === "darwin"
}

// ── Path helpers ──────────────────────────────────────────────────────────

/** PATH environment variable delimiter: `;` on Windows, `:` elsewhere. */
export function pathDelimiter(platform?: NodeJS.Platform): string {
  return isWindows(platform) ? ";" : ":"
}

/**
 * Extract shell name from a full path, handling both Unix and Windows paths.
 * Strips `.exe` suffix on Windows.
 *
 *   "/bin/zsh"                      → "zsh"
 *   "C:\\Program Files\\Git\\bin\\bash.exe" → "bash"
 *   undefined                       → ""
 */
export function shellBaseName(shellPath: string | undefined): string {
  if (!shellPath) return ""
  const base = path.basename(shellPath)
  return base.replace(/\.exe$/i, "")
}

// ── Feature flags ─────────────────────────────────────────────────────────

/** True on macOS/Linux. On Windows, true only if bash is likely available (Git Bash). */
export function hasUnixShell(platform?: NodeJS.Platform): boolean {
  if (!isWindows(platform)) return true
  // Heuristic: Git Bash adds its bin dir to PATH
  const pathEnv = process.env.PATH || ""
  return /\\Git\\usr\\bin|\\Git\\bin/i.test(pathEnv)
}

// ── File helpers ──────────────────────────────────────────────────────────

/** File mode for executable scripts. NTFS ignores the execute bit. */
export function execMode(platform?: NodeJS.Platform): number {
  return isWindows(platform) ? 0o644 : 0o755
}

/** Wrapper script extension: `.cmd` on Windows, empty on Unix. */
export function wrapperExt(platform?: NodeJS.Platform): string {
  return isWindows(platform) ? ".cmd" : ""
}

/** Primary notify script name by platform. */
export function notifyScriptName(platform?: NodeJS.Platform): string {
  return isWindows(platform) ? "notify.js" : "notify.sh"
}
