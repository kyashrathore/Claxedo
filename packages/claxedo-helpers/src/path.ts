import path, { isAbsolute, join } from "node:path"
import { homedir } from "node:os"
import { envText } from "./env"

/**
 * Containment by relative path: the candidate is inside when its path down
 * from the root needs no `..` escape. The filesystem root therefore contains
 * every absolute path on its drive, while a sibling that merely shares the
 * root as a string prefix (/a/workspace-old under root /a/workspace) does not.
 *
 * The comparison is lexical — `relative` resolves `.`/`..` segments but there
 * is no realpath and no case folding — so where the check is a security
 * boundary the caller still passes `fs.realpath`'d values.
 */
export function inside(root: string, candidate: string, paths: typeof path = path): boolean {
  const descent = paths.relative(root, candidate)
  return descent === "" || (descent !== ".." && !descent.startsWith(`..${paths.sep}`) && !paths.isAbsolute(descent))
}

/**
 * A configured directory must be absolute, because a relative one resolves
 * against whatever cwd the process happens to have — under a test runner that
 * is the package root, so the directory lands in the working tree.
 *
 * `"undefined"` arrives here whenever something restored a saved value with
 * `env[key] = saved`: assigning `undefined` to a `process.env` key stores the
 * six-character string, which every `??` default then accepts as a real path.
 * Refusing it names the polluter instead of silently creating `./undefined`.
 */
export function absoluteConfiguredDir(key: string, value: string): string {
  if (isAbsolute(value)) return value
  throw new Error(`${key} must be an absolute path, received ${JSON.stringify(value)}`)
}

/**
 * The home directory `os.homedir()` would report, read from `env` on every
 * call. Bun 1.3 snapshots HOME at startup, so a HOME a test preload assigns
 * later never reaches Bun's `os.homedir()`; Node reads it per call, where the
 * two agree.
 */
export function userHomeDir(env: Record<string, string | undefined> = process.env): string {
  return envText(env, process.platform === "win32" ? "USERPROFILE" : "HOME") ?? homedir()
}

/**
 * Where this process keeps Claxedo's data, and the state under it. One owner:
 * the runtime, the server and their tests all resolve `CLAXEDO_DATA_DIR` the
 * same way, including the `:memory:` sentinel that `ClaxedoDB.Path` forwards
 * to sqlite instead of joining a file onto.
 */
export function claxedoDataDir(env: Record<string, string | undefined> = process.env): string {
  const configured = envText(env, "CLAXEDO_DATA_DIR")
  if (configured === undefined) return join(homedir(), ".claxedo")
  if (configured === ":memory:") return configured
  return absoluteConfiguredDir("CLAXEDO_DATA_DIR", configured)
}

export function claxedoStateDir(env: Record<string, string | undefined> = process.env): string {
  const configured = envText(env, "CLAXEDO_STATE_DIR")
  if (configured === undefined) return join(claxedoDataDir(env), "state")
  return absoluteConfiguredDir("CLAXEDO_STATE_DIR", configured)
}
