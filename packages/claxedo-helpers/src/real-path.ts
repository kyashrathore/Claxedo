import { realpathSync, watch, type FSWatcher, type WatchListener, type WatchOptions } from "node:fs"
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

/**
 * libuv 1.52.1's Windows fs-event handler expands every change it reports with
 * `GetLongPathNameW` and asserts the result still starts with the directory
 * string it was handed, so a directory watched under an 8.3 spelling such as
 * `C:\Users\RUNNER~1\AppData\Local\Temp` aborts the whole process on its first
 * change: "Assertion failed: !_wcsnicmp(filename, dir, dirlen)", exit code 9.
 * Node 24.21.0 floats a fallback; Node 24.20.0 and Electron 43's Node 24.18.0
 * do not. {@link realDirectoryPath} reaches `GetFinalPathNameByHandle`, which
 * returns the long spelling.
 *
 * The resolved spelling is the watcher's alone: callers keep publishing the
 * path they were given. A listener that filters compares the reported name
 * against its target's basename — re-joining it onto the directory the caller
 * passed would never equal the resolved one, and the watcher would silently
 * stop firing.
 */
export function watchRealDirectory(
  dir: string,
  options: Omit<WatchOptions, "encoding"> | undefined,
  listener: WatchListener<string>,
): FSWatcher {
  return watch(realDirectoryPath(dir), options, listener)
}
