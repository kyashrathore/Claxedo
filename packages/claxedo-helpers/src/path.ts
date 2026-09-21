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
