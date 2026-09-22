import { readFileSync, statSync } from "node:fs"
import path from "node:path"

/**
 * Whether this binary is a Windows .cmd/.bat launcher, which CreateProcess
 * cannot execute directly. That is the launcher shape an npm install puts on
 * a Windows PATH for codex and for ACP CLIs alike; `resolveHarnessCommand`
 * resolves it to the executable it wraps instead of routing it through a
 * shell.
 */
export function isWindowsShimBinary(binary: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(binary)
}

const WINDOWS_SCRIPT_TARGET = /\.(?:cjs|mjs|js)$/i
const WINDOWS_LAUNCHABLE_TARGET = /\.(?:exe|com|cmd|bat|cjs|mjs|js)$/i
const SHIM_DEPTH_LIMIT = 4

function isRegularFile(candidate: string) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const value = Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? ""
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
}

/**
 * Locate a shim the way `cmd /c` would have: the launch directory first for a
 * bare name, then PATH; a name carrying separators resolves against the
 * launch directory alone.
 */
function locateShim(command: string, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform) {
  if (/[\\/]/.test(command)) {
    const resolved = path.resolve(cwd, command)
    return isRegularFile(resolved) ? resolved : undefined
  }
  for (const directory of [cwd, ...pathEntries(env, platform)]) {
    const candidate = path.join(directory, command)
    if (isRegularFile(candidate)) return candidate
  }
  return undefined
}

/**
 * The paths a batch shim names, in file order: quoted tokens — which is how
 * npm, Yarn and hand-written shims spell the target — plus bare `%~dp0`-style
 * references. `%~dp0` expands to the shim's own directory, so those resolve
 * relative to it; already-absolute tokens are kept verbatim. In the npm
 * layout the executable line is last, after the `node.exe` probe, so callers
 * pick the last existing candidate.
 */
function shimTargetTokens(content: string, shimDir: string) {
  const targets: string[] = []
  for (const match of content.matchAll(/"([^"\r\n]+)"|(?:%~dp0|%dp0%)[^\s"'&|<>]*/gi)) {
    const token = match[1] ?? match[0]
    const resolved = token.replace(/%~dp0|%dp0%/gi, `${shimDir}${path.sep}`)
    if (resolved === token && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(token)) continue
    targets.push(path.resolve(resolved.replace(/[\\/]+/g, path.sep)))
  }
  return targets
}

function shimCommand(
  shim: string,
  args: string[],
  platform: NodeJS.Platform,
  depth: number,
): { command: string; args: string[] } {
  if (depth > SHIM_DEPTH_LIMIT) throw new Error(`Windows batch shim ${shim} nests deeper than ${SHIM_DEPTH_LIMIT} launchers`)
  let content: string
  try {
    content = readFileSync(shim, "utf8").slice(0, 64 * 1024)
  } catch (cause) {
    throw new Error(`Cannot read Windows batch shim ${shim}`, { cause })
  }
  const target = shimTargetTokens(content, path.dirname(shim)).filter(isRegularFile).at(-1)
  if (!target || !WINDOWS_LAUNCHABLE_TARGET.test(target)) {
    throw new Error(
      `Windows batch shim ${shim} does not resolve to a real executable; configure the agent's executable path directly`,
    )
  }
  if (isWindowsShimBinary(target, platform)) return shimCommand(target, args, platform, depth + 1)
  if (WINDOWS_SCRIPT_TARGET.test(target)) return { command: process.execPath, args: [target, ...args] }
  return { command: target, args }
}

/**
 * The argv a harness launch actually spawns.
 *
 * A Windows `.cmd`/`.bat` launcher cannot be executed by CreateProcess, and
 * routing it through `cmd /c` hands every argument to the shell's parser,
 * where `&`, `|` and `%VAR%` stop being data. Batch argument quoting cannot
 * preserve them (a literal `%` has no `cmd /c` escape at all), so the shim is
 * resolved to the executable it wraps and spawned directly — a script through
 * `process.execPath`, a `.exe` as itself — keeping every configured argument
 * a literal argv entry. A shim that names no resolvable target is refused
 * rather than shelled.
 */
export function resolveHarnessCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (!isWindowsShimBinary(command, platform)) return { command, args }
  const shim = locateShim(command, env, cwd, platform)
  if (!shim) {
    throw new Error(`Windows batch shim ${command} was not found; configure the agent's executable path directly`)
  }
  return shimCommand(shim, args, platform, 0)
}
