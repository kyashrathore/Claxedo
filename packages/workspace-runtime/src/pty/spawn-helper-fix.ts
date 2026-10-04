/**
 * Bun's package manager may strip execute bits from prebuilt native binaries.
 * @lydell/node-pty requires its `spawn-helper` binary to be executable on
 * macOS — without it, posix_spawnp fails and PTY creation throws. (Linux
 * prebuilds carry no spawn-helper; Windows never uses one.)
 *
 * Call ensureSpawnHelper() once before first use of @lydell/node-pty to fix
 * this.
 */
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)

export function spawnHelperPath(): string | undefined {
  try {
    // The platform package (`@lydell/node-pty-<platform>-<arch>`) is an
    // optionalDependency of the wrapper, which bun links only inside its
    // content-addressed store. require.resolve realpaths the wrapper, so its
    // scope directory is the one place the platform package is ALWAYS a
    // sibling — both in the store and in a packaged app's node_modules.
    const wrapperDir = path.dirname(require.resolve("@lydell/node-pty/package.json"))
    const platform = `${process.platform}-${process.arch}`
    return path.join(path.dirname(wrapperDir), `node-pty-${platform}`, "prebuilds", platform, "spawn-helper")
  } catch {
    return undefined
  }
}

export async function ensureSpawnHelper(helper = spawnHelperPath()) {
  if (process.platform === "win32") return
  if (!helper) return
  for (const candidate of spawnHelperCandidates(helper)) {
    try {
      const stat = await fs.promises.stat(candidate)
      if (stat.mode & 0o111) continue
      await fs.promises.chmod(candidate, 0o755)
    } catch {}
  }
}

// In a packaged Electron app require.resolve points inside the read-only
// app.asar archive, while node-pty actually execs the app.asar.unpacked copy.
export function spawnHelperCandidates(helper: string) {
  const asar = `app.asar${path.sep}`
  if (!helper.includes(asar) || helper.includes(`app.asar.unpacked${path.sep}`)) return [helper]
  return [helper, helper.replace(asar, `app.asar.unpacked${path.sep}`)]
}
