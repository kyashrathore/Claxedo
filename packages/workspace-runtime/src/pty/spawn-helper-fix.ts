/**
 * Bun's package manager may strip execute bits from prebuilt native binaries.
 * node-pty requires its `spawn-helper` binary to be executable — without it,
 * posix_spawnp fails and PTY creation throws.
 *
 * Call ensureSpawnHelper() once before first use of node-pty to fix this.
 */
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)

export function spawnHelperPath(): string | undefined {
  try {
    const pkgDir = path.dirname(require.resolve("node-pty/package.json"))
    return path.join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
  } catch {
    return undefined
  }
}

export async function ensureSpawnHelper() {
  if (process.platform === "win32") return
  const helper = spawnHelperPath()
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
