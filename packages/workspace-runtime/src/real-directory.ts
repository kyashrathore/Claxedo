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
