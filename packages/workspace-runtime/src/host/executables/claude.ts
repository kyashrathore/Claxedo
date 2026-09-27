import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * The Claude native harness spawns the Claude Code CLI out of process — the
 * `@anthropic-ai/claude-agent-sdk` npm package is only a ~1MB launcher. We
 * deliberately do NOT bundle the SDK's 230MB per-platform native binary; the
 * policy (matching t3code/paseo/superset) is: use the `claude` the user (or the
 * sandbox image) has installed, pointed at via `pathToClaudeCodeExecutable`. On
 * absence we surface an actionable install CTA rather than shipping a binary.
 */

/** Explicit override; wins over discovery when it points at a real executable. */
export const CLAUDE_EXECUTABLE_ENV = "CLAUDE_CODE_EXECUTABLE"

/** How to install Claude Code, surfaced in the not-found error. */
export const CLAUDE_INSTALL_HINT =
  "Install it with `npm install -g @anthropic-ai/claude-code` (or see https://docs.claude.com/claude-code), " +
  `or set ${CLAUDE_EXECUTABLE_ENV} to its path.`

/**
 * npm launcher-script extensions Node cannot spawn without a shell (`spawn
 * EINVAL` since Node 20.12), so the SDK — which spawns the path directly — can't
 * use them. On Windows we follow such a shim to the real package entry.
 */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"])

/**
 * Entry points of `@anthropic-ai/claude-code` relative to the `node_modules`
 * next to a Windows npm launcher shim. Newer versions ship `bin/claude.exe`;
 * older ones only `cli.js`, which the SDK runs with a JS runtime.
 */
const NPM_PACKAGE_ENTRY_CANDIDATES: ReadonlyArray<ReadonlyArray<string>> = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
]

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  if (!isFile(candidate)) return false
  if (platform === "win32") return true
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * The SDK spawns the executable directly (no shell, no PATHEXT). A Windows npm
 * install resolves `claude` to a `.cmd`/`.ps1` shim it can't spawn, so follow
 * the shim to the package's real entry point. Posix paths pass through.
 */
function normalizeForSdkSpawn(resolved: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return resolved
  const extension = path.win32.extname(resolved).toLowerCase()
  if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) return resolved
  const shimDirectory = path.win32.dirname(resolved)
  for (const segments of NPM_PACKAGE_ENTRY_CANDIDATES) {
    const candidate = path.win32.join(shimDirectory, ...segments)
    if (isFile(candidate)) return candidate
  }
  return resolved
}

/** Resolve a bare command against PATH (+ PATHEXT on Windows). */
function resolveOnPath(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix
  const extensions = platform === "win32" ? windowsPathExtensions(env) : [""]
  const hasExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext))
  const names = platform === "win32" && !hasExtension ? extensions.map((ext) => `${command}${ext}`) : [command]
  for (const entry of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1")
    if (!dir) continue
    for (const name of names) {
      const candidate = p.join(dir, name)
      if (isExecutableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}

/** Standard Claude Code install locations that are not always on a GUI app's PATH. */
function standardInstallCandidates(platform: NodeJS.Platform, home: string): string[] {
  const bin = platform === "win32" ? "claude.exe" : "claude"
  const candidates: string[] = [
    // Native installer (`curl -fsSL https://claude.ai/install.sh | bash`).
    path.join(home, ".local", "bin", bin),
  ]
  if (platform === "darwin") {
    candidates.push(path.join("/opt/homebrew/bin", bin), path.join("/usr/local/bin", bin))
  } else if (platform === "linux") {
    candidates.push(path.join("/usr/local/bin", bin), path.join("/usr/bin", bin))
    if (process.env.HOME) candidates.push(path.join(home, ".npm-global", "bin", bin))
  }
  return candidates
}

/**
 * Resolve the Claude Code executable to pass as the SDK's
 * `pathToClaudeCodeExecutable`. Order: explicit override env → PATH → standard
 * install locations. Returns `undefined` when Claude Code is not installed.
 */
export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | undefined {
  const override = env[CLAUDE_EXECUTABLE_ENV]?.trim()
  if (override) {
    const resolved = override.includes(path.sep) || override.includes("/")
      ? (isExecutableFile(override, platform) || isFile(override) ? override : resolveOnPath(override, platform, env))
      : resolveOnPath(override, platform, env)
    if (resolved) return normalizeForSdkSpawn(resolved, platform)
    // An explicit override that does not resolve is a configuration error worth
    // surfacing, not silently ignoring in favor of a different install.
    return undefined
  }

  const onPath = resolveOnPath(platform === "win32" ? "claude.exe" : "claude", platform, env)
  if (onPath) return normalizeForSdkSpawn(onPath, platform)

  for (const candidate of standardInstallCandidates(platform, home)) {
    if (isExecutableFile(candidate, platform)) return normalizeForSdkSpawn(candidate, platform)
  }
  return undefined
}

/** Like {@link resolveClaudeExecutable} but throws an actionable error when absent. */
export function requireClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const resolved = resolveClaudeExecutable(env, platform, home)
  if (resolved) return resolved
  throw new Error(`Claude Code is not installed or not on PATH. ${CLAUDE_INSTALL_HINT}`)
}
