import { isAbsolute, relative, sep } from "node:path"

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
export function inside(root: string, candidate: string): boolean {
  const descent = relative(root, candidate)
  return descent === "" || (descent !== ".." && !descent.startsWith(`..${sep}`) && !isAbsolute(descent))
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
