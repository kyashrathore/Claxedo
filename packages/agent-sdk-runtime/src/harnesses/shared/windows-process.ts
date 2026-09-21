import { spawn, type ChildProcess } from "child_process"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { isRecord } from "@claxedo/helpers/guards"

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

/**
 * Kill a spawned harness child, taking its whole process tree down on Windows.
 *
 * Two reasons this is not `proc.kill()` there:
 *
 *   - A harness child's descendants (the executable a resolved shim wraps,
 *     plugin clones, tool children) keep their cwd and open files locked
 *     after the leader dies — which is exactly what pins temp directories
 *     (EBUSY) and keeps a "disposed" server serving.
 *   - Windows has no signals; kill() is TerminateProcess on ONE pid either
 *     way, so the tree flag is the only part of the semantics we can choose,
 *     and dispose means the server AND its children are gone.
 *
 * On POSIX callers that spawned with `detached: true` can explicitly signal
 * their owned process group. Other callers retain single-process signaling.
 */
export function killHarnessProcess(proc: ChildProcess, signal: NodeJS.Signals, ownedProcessGroup = false) {
  if (process.platform !== "win32" && ownedProcessGroup && proc.pid) {
    try {
      process.kill(-proc.pid, signal)
    } catch (error) {
      if (!isRecord(error) || error.code !== "ESRCH") throw new Error(`Could not signal harness group ${proc.pid} with ${signal}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return
  }
  if (process.platform === "win32" && proc.pid && proc.exitCode === null && proc.signalCode === null) {
    try {
      return spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      // taskkill missing or refused — fall through to the single-pid kill.
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // Already exited.
  }
}

/** Wait until an owned POSIX group is gone, including children of an exited leader. */
export async function drainHarnessProcessGroup(proc: ChildProcess, timeoutMs = Infinity) {
  const pid = proc.pid
  if (process.platform === "win32" || !pid) return
  let denied: unknown
  const permissionDenied = (error: unknown) => isRecord(error) && (error.code === "EPERM" || isRecord(error.cause) && error.cause.code === "EPERM")
  const signal = (value: NodeJS.Signals) => {
    try { killHarnessProcess(proc, value, true) }
    catch (error) {
      if (!permissionDenied(error)) throw error
      denied = error
    }
  }
  signal("SIGTERM")
  const started = Date.now()
  let escalated = false
  for (;;) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") return
      // Darwin killpg excludes zombies before counting permitted recipients,
      // so an exiting group can temporarily return EPERM. This is not proof
      // of exit: keep waiting for ESRCH and fail if permission stays denied.
      if (!permissionDenied(error)) throw new Error(`Could not inspect harness group ${pid}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      denied = error
    }
    if (!escalated && Date.now() - started >= 1_000) {
      signal("SIGKILL")
      escalated = true
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`Harness process group ${pid} did not terminate${denied instanceof Error ? `: ${denied.message}` : ""}`, { cause: denied })
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
