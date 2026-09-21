import { realpathSync } from "node:fs"
import path from "node:path"

/**
 * A directory as the filesystem names it: publishers and readers of the
 * runtime bus compare workspaces by this, and macOS spells `/tmp` as
 * `/private/tmp` once resolved. A path that does not exist resolves lexically.
 */
export function realDirectoryPath(dir: string) {
  try {
    return path.resolve(realpathSync.native?.(dir) ?? realpathSync(dir))
  } catch {
    return path.resolve(dir)
  }
}

/**
 * A path as the filesystem names it, resolved through the part of it that
 * exists. A leaf that is not there yet keeps its spelling on the end of the
 * real directory that would hold it, so `linked-dir/new-file` is still
 * compared as a path under the link's target.
 */
export function realPathAllowingMissing(candidate: string) {
  let current = path.resolve(candidate)
  const remainder: string[] = []
  while (true) {
    try {
      const real = path.resolve(realpathSync.native?.(current) ?? realpathSync(current))
      return remainder.length === 0 ? real : path.join(real, ...remainder.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(candidate)
      remainder.push(path.basename(current))
      current = parent
    }
  }
}
